import { ArgsType, Field } from 'type-graphql'
import { PaginationArgs } from './PaginationArgs'

export enum Sort {
  NEW = 'new',
  TOP = 'top',
  HOT = 'hot',
}

export enum Time {
  HOUR = 'hour',
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
  YEAR = 'year',
  ALL = 'all',
}

export enum Filter {
  ALL = 'all',
  FOLLOWING = 'following',
}

@ArgsType()
export class FeedArgs extends PaginationArgs {
  @Field(type => Sort, { defaultValue: Sort.HOT })
  sort: Sort = Sort.HOT

  @Field(type => Time, { defaultValue: Time.ALL })
  time: Time = Time.ALL

  @Field(type => Filter, { defaultValue: Filter.ALL })
  filter: Filter = Filter.ALL
}
