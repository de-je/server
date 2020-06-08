import {
  Arg,
  Args,
  Ctx,
  FieldResolver,
  ID,
  Mutation,
  Query,
  Resolver,
  Root,
  UseMiddleware,
} from 'type-graphql'
import { RepositoryInjector } from '../RepositoryInjector'
import { Post, PostType } from '../entities/Post'
import { SubmitPostArgs } from '../args/SubmitPostArgs'
import { RequiresAuth } from '../RequiresAuth'
import { Context } from '../Context'
import shortid from 'shortid'
import Mercury from '@postlight/mercury-parser'
// @ts-ignore
import isImageUrl from 'is-image-url'
// @ts-ignore
import Url from 'url-parse'
import { Topic } from '../entities/Topic'
import { getThumbnailUrl } from '../thumbnail'
import { PostView } from '../entities/PostView'
// @ts-ignore
import getTitleAtUrl from 'get-title-at-url'
import { FeedArgs, Filter, Sort, Time } from '../args/FeedArgs'
import AWS from 'aws-sdk'
import axios from 'axios'
import sharp from 'sharp'
import { User } from '../entities/User'
import { SearchPostsArgs } from '../args/SearchPostsArgs'
import { differenceInSeconds } from 'date-fns'

const s3 = new AWS.S3({
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
})

@Resolver(of => Post)
export class PostResolver extends RepositoryInjector {
  @Query(returns => String)
  async getTitleAtUrl(@Arg('url') url: string) {
    return await new Promise(resolve => {
      getTitleAtUrl(url, (title: any) => resolve(title ? title : ''))
    })
  }

  @Query(returns => [Post])
  async searchPosts(
    @Args() { page, pageSize, search, sort, time }: SearchPostsArgs,
    @Ctx() { userId }: Context,
  ) {
    if (!search) return []

    const qb = this.postRepository
      .createQueryBuilder('post')
      .addSelect('ts_rank_cd(to_tsvector(post.textContent), to_tsquery(:query))', 'textrank')
      .addSelect('ts_rank_cd(to_tsvector(post.link), to_tsquery(:query))', 'linkrank')
      .addSelect('ts_rank_cd(to_tsvector(post.title), to_tsquery(:query))', 'titlerank')
      .orderBy('titlerank', 'DESC')
      .addOrderBy('textrank', 'DESC')
      .addOrderBy('linkrank', 'DESC')
      .setParameter('query', search)
      .andWhere('post.deleted = false')
      .skip(page * pageSize)
      .take(pageSize)

    if (sort === Sort.TOP) {
      switch (time) {
        case Time.HOUR:
          qb.andWhere("post.createdAt > NOW() - INTERVAL '1 hour'")
          break
        case Time.DAY:
          qb.andWhere("post.createdAt > NOW() - INTERVAL '1 day'")
          break
        case Time.WEEK:
          qb.andWhere("post.createdAt > NOW() - INTERVAL '1 week'")
          break
        case Time.MONTH:
          qb.andWhere("post.createdAt > NOW() - INTERVAL '1 month'")
          break
        case Time.YEAR:
          qb.andWhere("post.createdAt > NOW() - INTERVAL '1 year'")
          break
        case Time.ALL:
          break
        default:
          break
      }
      qb.addOrderBy('post.endorsementCount', 'DESC')
    }

    qb.addOrderBy('post.createdAt', 'DESC')

    if (userId) {
      const hiddenTopics = (
        await this.userRepository
          .createQueryBuilder()
          .relation(User, 'hiddenTopics')
          .of(userId)
          .loadMany()
      ).map(topic => topic.name)

      if (hiddenTopics.length > 0) {
        qb.andWhere(
          'COALESCE(ARRAY_LENGTH(ARRAY(SELECT UNNEST(:hiddenTopics::text[]) INTERSECT SELECT UNNEST(post.topicsarr::text[])), 1), 0) = 0',
        ).setParameter('hiddenTopics', hiddenTopics)
      }

      const blockedUsers = (
        await this.userRepository
          .createQueryBuilder()
          .relation(User, 'blockedUsers')
          .of(userId)
          .loadMany()
      ).map(user => user.id)

      qb.andWhere('NOT (post.authorId = ANY(:blockedUsers))', { blockedUsers })

      const hiddenPosts = (
        await this.userRepository
          .createQueryBuilder()
          .relation(User, 'hiddenPosts')
          .of(userId)
          .loadMany()
      ).map(post => post.id)

      qb.andWhere('NOT (post.id = ANY(:hiddenPosts))', { hiddenPosts })

      qb.loadRelationCountAndMap(
        'post.personalEndorsementCount',
        'post.endorsements',
        'endorsement',
        qb => {
          return qb
            .andWhere('endorsement.active = true')
            .andWhere('endorsement.userId = :userId', { userId })
        },
      )
    }

    const posts = await qb
      .leftJoinAndSelect('post.topics', 'topic')
      .loadRelationCountAndMap('post.commentCount', 'post.comments')
      .getMany()

    posts.forEach(post => (post.isEndorsed = Boolean(post.personalEndorsementCount)))

    return posts
  }

  @Query(returns => [Post])
  async homeFeed(
    @Args() { page, pageSize, sort, time, filter }: FeedArgs,
    @Ctx() { userId }: Context,
  ) {
    const qb = this.postRepository
      .createQueryBuilder('post')
      .andWhere('post.deleted = false')
      .andWhere('post.sticky = false')

    if (sort === Sort.NEW) {
      qb.addOrderBy('post.createdAt', 'DESC')
    } else if (sort === Sort.HOT) {
      qb.addSelect(
        'CAST(post.endorsementCount AS float)/((CAST((CAST(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) AS int) - CAST(EXTRACT(EPOCH FROM post.createdAt) AS int)+100000) AS FLOAT)/6.0)^(1.0/3.0))',
        'post_hotrank',
      )
      qb.addOrderBy('post_hotrank', 'DESC')
    } else if (sort === Sort.TOP) {
      switch (time) {
        case Time.HOUR:
          qb.andWhere("post.createdAt > NOW() - INTERVAL '1 hour'")
          break
        case Time.DAY:
          qb.andWhere("post.createdAt > NOW() - INTERVAL '1 day'")
          break
        case Time.WEEK:
          qb.andWhere("post.createdAt > NOW() - INTERVAL '1 week'")
          break
        case Time.MONTH:
          qb.andWhere("post.createdAt > NOW() - INTERVAL '1 month'")
          break
        case Time.YEAR:
          qb.andWhere("post.createdAt > NOW() - INTERVAL '1 year'")
          break
        case Time.ALL:
          break
        default:
          break
      }
      qb.addOrderBy('post.endorsementCount', 'DESC')
      qb.addOrderBy('post.createdAt', 'DESC')
    }

    if (filter === Filter.FOLLOWING && userId) {
      const followedTopics = (
        await this.userRepository
          .createQueryBuilder()
          .relation(User, 'followedTopics')
          .of(userId)
          .loadMany()
      ).map(topic => topic.name)

      if (followedTopics.length > 0) {
        qb.andWhere(
          'COALESCE(ARRAY_LENGTH(ARRAY(SELECT UNNEST(:followedTopics::text[]) INTERSECT SELECT UNNEST(post.topicsarr::text[])), 1), 0) > 0',
        ).setParameter('followedTopics', followedTopics)
      } else {
        return []
      }
    }

    if (userId) {
      const hiddenTopics = (
        await this.userRepository
          .createQueryBuilder()
          .relation(User, 'hiddenTopics')
          .of(userId)
          .loadMany()
      ).map(topic => topic.name)

      if (hiddenTopics.length > 0) {
        qb.andWhere(
          'COALESCE(ARRAY_LENGTH(ARRAY(SELECT UNNEST(:hiddenTopics::text[]) INTERSECT SELECT UNNEST(post.topicsarr::text[])), 1), 0) = 0',
        ).setParameter('hiddenTopics', hiddenTopics)
      }

      const blockedUsers = (
        await this.userRepository
          .createQueryBuilder()
          .relation(User, 'blockedUsers')
          .of(userId)
          .loadMany()
      ).map(user => user.id)

      qb.andWhere('NOT (post.authorId = ANY(:blockedUsers))', { blockedUsers })

      const hiddenPosts = (
        await this.userRepository
          .createQueryBuilder()
          .relation(User, 'hiddenPosts')
          .of(userId)
          .loadMany()
      ).map(post => post.id)

      qb.andWhere('NOT (post.id = ANY(:hiddenPosts))', { hiddenPosts })

      qb.loadRelationCountAndMap(
        'post.personalEndorsementCount',
        'post.endorsements',
        'endorsement',
        qb => {
          return qb
            .andWhere('endorsement.active = true')
            .andWhere('endorsement.userId = :userId', { userId })
        },
      )
    }

    const posts = await qb
      .skip(page * pageSize)
      .take(pageSize)
      .leftJoinAndSelect('post.topics', 'topic')
      .loadRelationCountAndMap('post.commentCount', 'post.comments')
      .getMany()

    posts.forEach(post => (post.isEndorsed = Boolean(post.personalEndorsementCount)))

    return posts
  }

  @Query(returns => [Post])
  async hiddenPosts(@Ctx() { userId }: Context) {
    if (!userId) return []

    let posts = await this.userRepository
      .createQueryBuilder()
      .relation(User, 'hiddenPosts')
      .of(userId)
      .loadMany()

    if (posts.length === 0) return []

    const qb = this.postRepository
      .createQueryBuilder('post')
      .whereInIds(posts.map(post => post.id))
      .loadRelationCountAndMap('post.commentCount', 'post.comments')

    qb.loadRelationCountAndMap(
      'post.personalEndorsementCount',
      'post.endorsements',
      'endorsement',
      qb => {
        return qb
          .andWhere('endorsement.active = true')
          .andWhere('endorsement.userId = :userId', { userId })
      },
    )

    posts = await qb.leftJoinAndSelect('post.topics', 'topic').getMany()

    posts.forEach(post => {
      post.isEndorsed = Boolean(post.personalEndorsementCount)
      post.isHidden = true
    })

    return posts
  }

  @Query(returns => [Post])
  async globalStickies(@Ctx() { userId }: Context) {
    const qb = this.postRepository
      .createQueryBuilder('post')
      .andWhere('post.sticky = TRUE')
      .leftJoinAndSelect('post.topics', 'topic')
      .loadRelationCountAndMap('post.commentCount', 'post.comments')

    if (userId) {
      qb.loadRelationCountAndMap(
        'post.personalEndorsementCount',
        'post.endorsements',
        'endorsement',
        qb => {
          return qb
            .andWhere('endorsement.active = true')
            .andWhere('endorsement.userId = :userId', { userId })
        },
      )
    }

    const posts = await qb.getMany()

    posts.forEach(post => (post.isEndorsed = Boolean(post.personalEndorsementCount)))

    return posts
  }

  @Query(returns => Post, { nullable: true })
  async post(@Arg('postId', type => ID) postId: string, @Ctx() { userId }: Context) {
    const qb = this.postRepository
      .createQueryBuilder('post')
      .where('post.id = :postId', { postId })
      .andWhere('post.deleted = false')
      .loadRelationCountAndMap('post.commentCount', 'post.comments')

    if (userId) {
      qb.loadRelationCountAndMap(
        'post.personalEndorsementCount',
        'post.endorsements',
        'endorsement',
        qb => {
          return qb
            .andWhere('endorsement.active = true')
            .andWhere('endorsement.userId = :userId', { userId })
        },
      )
    }

    const post = await qb.leftJoinAndSelect('post.topics', 'topic').getOne()

    if (!post) return null

    post.isEndorsed = Boolean(post.personalEndorsementCount)

    return post
  }

  @Mutation(returns => PostView, { nullable: true })
  async recordPostView(@Arg('postId', type => ID) postId: string, @Ctx() { userId }: Context) {
    if (!userId) return null

    let postView = await this.postViewRepository.findOne({ postId, userId })

    console.log(postView)

    const post = await this.postRepository
      .createQueryBuilder('post')
      .andWhereInIds(postId)
      .loadRelationCountAndMap('post.commentCount', 'post.comments')
      .getOne()

    if (!post) throw new Error('Invalid post id')

    if (postView) {
      await this.postViewRepository.update({ userId, postId }, {
        createdAt: new Date(),
        lastCommentCount: post.commentCount,
      } as PostView)
    } else {
      postView = await this.postViewRepository.save({
        createdAt: new Date(),
        userId,
        postId,
        lastCommentCount: post.commentCount,
      } as PostView)
    }

    return postView
  }

  @UseMiddleware(RequiresAuth)
  @Mutation(returns => Post)
  async submitPost(
    @Args() { title, type, link, textContent, topics }: SubmitPostArgs,
    @Ctx() { userId }: Context,
  ) {
    const user = await this.userRepository.findOne(userId)

    if (user.lastPostedAt && !user.admin) {
      if (differenceInSeconds(new Date(), user.lastPostedAt) < 60 * 3) {
        throw new Error('Please wait 3 minutes between posts')
      }
    }

    this.userRepository.update(userId, { lastPostedAt: new Date() })

    const url = new Url(link)
    let parseResult: any = null
    if (type === PostType.LINK) {
      if (isImageUrl(link)) {
        parseResult = {
          // eslint-disable-next-line @typescript-eslint/camelcase
          lead_image_url: link,
        }
      } else {
        const longTask = () =>
          new Promise(async resolve => {
            try {
              resolve(await Mercury.parse(link))
            } catch (e) {
              resolve({})
            }
          })

        const timeout = (cb: any, interval: number) => () =>
          new Promise(resolve => setTimeout(() => cb(resolve), interval))

        const onTimeout = timeout((resolve: any) => resolve({}), 3000)

        parseResult = await Promise.race([longTask, onTimeout].map(f => f()))

        if (!parseResult.lead_image_url) {
          try {
            // eslint-disable-next-line @typescript-eslint/camelcase
            parseResult.lead_image_url = await getThumbnailUrl(link)
          } catch (e) {}
        }
      }
      parseResult.domain = url.hostname
    }

    const postId = shortid.generate()
    let s3UploadLink = ''

    if (type === PostType.LINK && parseResult && parseResult.lead_image_url) {
      const response = await axios.get(parseResult.lead_image_url, { responseType: 'arraybuffer' })
      const isYoutube = parseResult.lead_image_url.includes('ytimg.com')
      const resizedImage = await sharp(response.data)
        .resize(isYoutube ? 128 : 72, 72)
        .jpeg()
        .toBuffer()

      s3UploadLink = await new Promise((resolve, reject) =>
        s3.upload(
          { Bucket: 'comet-thumbs', Key: `${postId}.jpeg`, Body: resizedImage },
          (err, data) => {
            if (err) reject(err)
            else resolve(data.Location)
          },
        ),
      )
    }

    const savedTopics = await this.topicRepository.save(
      topics.map(topic => ({ name: topic.toLowerCase().replace(/ /g, '_') } as Topic)),
    )

    return this.postRepository.save({
      id: postId,
      title,
      type,
      link,
      textContent,
      createdAt: new Date(),
      authorId: userId,
      thumbnailUrl: s3UploadLink ? s3UploadLink : undefined,
      domain: parseResult ? parseResult.domain.replace('www.', '') : undefined,
      topics: savedTopics,
      topicsarr: savedTopics.map(topic => topic.name),
    } as Post)
  }

  @UseMiddleware(RequiresAuth)
  @Mutation(returns => Boolean)
  async deletePost(@Arg('postId', type => ID) postId: string, @Ctx() { userId }: Context) {
    const post = await this.postRepository.findOne({ id: postId })
    if (post.authorId !== userId)
      throw new Error('Attempt to delete post by someone other than author')

    await this.postRepository
      .createQueryBuilder()
      .update()
      .set({ deleted: true })
      .where('id = :postId', { postId })
      .execute()

    return true
  }

  @UseMiddleware(RequiresAuth)
  @Mutation(returns => Boolean)
  async togglePostEndorsement(
    @Arg('postId', type => ID) postId: string,
    @Ctx() { userId }: Context,
  ) {
    const post = await this.postRepository
      .createQueryBuilder('post')
      .whereInIds(postId)
      .leftJoinAndSelect('post.author', 'author')
      .getOne()
    if (!post) throw new Error('Invalid postId')

    if (userId === post.authorId) throw new Error('Cannot endorse your own post')

    let active: boolean

    const endorsement = await this.postEndorsementRepository.findOne({ postId, userId })
    if (endorsement) {
      await this.postEndorsementRepository.update(
        { postId, userId },
        { active: !endorsement.active },
      )
      active = !endorsement.active
    } else {
      await this.postEndorsementRepository.save({
        postId,
        userId,
        createdAt: new Date(),
        active: true,
      })
      active = true
    }

    this.postRepository.update(
      { id: postId },
      { endorsementCount: active ? post.endorsementCount + 1 : post.endorsementCount - 1 },
    )

    const author = await post.author
    this.userRepository.update(
      { id: author.id },
      { endorsementCount: active ? author.endorsementCount + 1 : author.endorsementCount - 1 },
    )

    return active
  }

  @UseMiddleware(RequiresAuth)
  @Mutation(returns => Boolean)
  async hidePost(@Arg('postId', type => ID) postId: string, @Ctx() { userId }: Context) {
    await this.userRepository
      .createQueryBuilder()
      .relation(User, 'hiddenPosts')
      .of(userId)
      .remove(postId)

    await this.userRepository
      .createQueryBuilder()
      .relation(User, 'hiddenPosts')
      .of(userId)
      .add(postId)
    return true
  }

  @UseMiddleware(RequiresAuth)
  @Mutation(returns => Boolean)
  async unhidePost(@Arg('postId', type => ID) postId: string, @Ctx() { userId }: Context) {
    await this.userRepository
      .createQueryBuilder()
      .relation(User, 'hiddenPosts')
      .of(userId)
      .remove(postId)
    return true
  }

  @FieldResolver()
  async author(@Root() post: Post, @Ctx() { userLoader }: Context) {
    return userLoader.load(post.authorId)
  }

  @FieldResolver()
  async postView(@Root() post: Post, @Ctx() { postViewLoader, userId }: Context) {
    return postViewLoader.load({ postId: post.id, userId })
  }

  @FieldResolver()
  async newCommentCount(@Root() post: Post, @Ctx() { userId }: Context) {
    if (!userId) return -1
    if (!post.postView) return -1
    return post.commentCount - post.postView.lastCommentCount
  }
}
