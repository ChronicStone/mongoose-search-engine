import { AggregatePaginateModel, Document } from "mongoose"

export type SearchPaginateModel<T extends Document> = AggregatePaginateModel<T>

export enum MatchMode {
  contains = "contains",
  arrayContains = "arrayContains",
  arrayContainsObject = "arrayContainsObject",
  between = "between",
  equals = "equals",
  notEquals = "notEquals",
  greaterThan = "greaterThan",
  greaterThanOrEqual = "greaterThanOrEqual",
  lessThan = "lessThan",
  lessThanOrEqual = "lessThanOrEqual",
  exists = "exists",
}

export enum SortOrder {
  asc = "asc",
  desc = "desc",
}

export interface Query {
  [key: string]: PropertyCondition[]
}

export interface QuickQuery {
  value: string
  fields: string[]
}

export interface AdditionalCondition {
  [key: string]: any
}

export interface AdditionalPostCondition {
  [key: string]: any
}

export interface PropertyCondition {
  value: string | string[] | Date[]
  matchMode: MatchMode
  required?: boolean
  property?: string
}

export interface PaginationOptions {
  limit: number
  page: number
  offset: number
}

export interface Field {
  field: string
  externalDocument?: boolean
}

export interface ModelPagination {
  offset?: number
  page?: number
  limit: number
  sortKey?: number
  sortOrder?: "asc" | "desc"
}

export interface PaginatedQuery extends ModelPagination {
  query?: Query
  searchQuery?: QuickQuery
  select?: Field[]
}
