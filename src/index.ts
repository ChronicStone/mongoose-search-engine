import { BadRequestException, Injectable, Logger } from "@nestjs/common"
import mongoose, { AggregatePaginateModel } from "mongoose"
import { pipeMergeObject } from "./utils"
import {
  AdditionalCondition,
  AdditionalPostCondition,
  PropertyCondition,
  MatchMode,
  QuickQuery,
  PaginationOptions,
  Query,
  PaginatedQuery,
} from "./types"

@Injectable()
export class SearchService {
  /**
   * create mongoose filters from request query
   * @param query
   * @param append
   * @param appendPostConditions
   */
  createFilters(
    query: Query,
    append: AdditionalCondition = null,
    appendPostConditions: AdditionalPostCondition = null,
  ) {
    if (!query) throw new BadRequestException("Filters: Query must not be null")
    const hasArrayObjectCondition = (filters: PropertyCondition[]): boolean => {
      return filters.some(
        (filter) => filter.matchMode === MatchMode.arrayContainsObject,
      )
    }
    const preConditions = []
    const postConditions = []
    for (const [k, filter] of Object.entries(query)) {
      if (k.includes(".") || hasArrayObjectCondition(filter))
        postConditions.push(this.createPropertyFilter(k, filter))
      else preConditions.push(this.createPropertyFilter(k, filter))
    }
    if (append) preConditions.push(append)
    if (appendPostConditions) postConditions.push(appendPostConditions)
    return {
      preConditions: preConditions.length > 0 && { $and: preConditions },
      postConditions: postConditions.length > 0 && { $and: postConditions },
    }
  }

  static getFilterFields(query: Query) {
    if (!query) return []
    return Object.keys(query)
  }

  /**
   * Create a quick filter
   * @param query
   * @param append
   * @param appendPostConditions
   */
  createQuickFilter(
    query: QuickQuery,
    append: AdditionalCondition = null,
    appendPostConditions: AdditionalPostCondition = null,
  ) {
    const preConditions = []
    const postConditions = []
    if (!query)
      throw new BadRequestException("QuickFilter: Query cannot be null")
    const { value, fields } = query
    if (!value)
      throw new BadRequestException(`QuickFilter: Filter Value is required`)
    if (!fields)
      throw new BadRequestException(`QuickFilter: Fields are required`)
    if (!Array.isArray(fields))
      throw new BadRequestException(`QuickFilter: Fields should be an array`)

    const hasAggregatedFields =
      fields.findIndex((field) => field.includes(".")) > -1

    for (const field of fields) {
      if (hasAggregatedFields)
        postConditions.push(this.createQuickPropertyFilterRow(field, value))
      else preConditions.push(this.createQuickPropertyFilterRow(field, value))
    }

    const preConditionsRows = [
      ...(append ? [append] : []),
      ...(preConditions?.length > 0 ? [{ $or: preConditions }] : []),
    ]

    const finalPreConditions =
      preConditionsRows?.length > 0
        ? {
            $and: preConditionsRows,
          }
        : {}

    const postConditionsRows = [
      ...(appendPostConditions ? [appendPostConditions] : []),
      ...(postConditions?.length > 0 ? [{ $or: postConditions }] : []),
    ]

    const finalPostConditions =
      postConditionsRows?.length > 0
        ? {
            $and: postConditionsRows,
          }
        : {}

    return {
      preConditions: finalPreConditions,
      postConditions: finalPostConditions,
    }
  }

  /**
   * Create aggregation description for mongoose aggregate function
   * @param paginatedQuery
   * @param lookup
   * @param append
   * @param appendPostConditions
   * @param ignoreSort
   */
  createAggregation(
    paginatedQuery: PaginatedQuery,
    lookup: any[],
    append: AdditionalCondition = null,
    appendPostConditions: AdditionalPostCondition = null,
    ignoreSort = false,
  ) {
    const { query, searchQuery } = paginatedQuery

    // [OLD BEHAVIOUR]
    // If query is set, we use it.
    // If query is not set, we check if searchQuery is set and use searchQuery.
    // If searchQuery is not set we use empty filters
    // const { preConditions, postConditions } = query
    //   ? this.createFilters(query, append, appendPostConditions)
    //   : searchQuery
    //   ? this.createQuickFilter(searchQuery, append, appendPostConditions)
    //   : {
    //       preConditions: append ? append : [],
    //       postConditions: appendPostConditions ? appendPostConditions : [],
    //     };

    // [NEW BEHAVIOUR]
    // BUILD CONDITIONS FOR BOTH QUERY AND SEARCH QUERY
    // THEN DEEPMERGE THEM WITH THE APPEND INJECTED IF NO FILTER IS SET

    const filtersCondition = query
      ? this.createFilters(query, append, appendPostConditions)
      : null

    const quickFilterCondition = searchQuery
      ? this.createQuickFilter(searchQuery, append, appendPostConditions)
      : null

    const mergedPreConditions = pipeMergeObject(
      filtersCondition?.preConditions ?? {},
      quickFilterCondition?.preConditions ?? {},
      !query && !searchQuery ? (append ? append : []) : {},
    )

    const mergedPostConditions = pipeMergeObject(
      filtersCondition?.postConditions ?? {},
      quickFilterCondition?.postConditions ?? {},
      !query && !searchQuery
        ? appendPostConditions
          ? appendPostConditions
          : []
        : {},
    )

    const aggregation = [
      {
        $match: {
          ...mergedPreConditions,
        },
      },
      ...(lookup ? lookup : []),
      {
        $match: {
          ...mergedPostConditions,
        },
      },
      ...(ignoreSort ? [] : this.createSortStage(paginatedQuery)),
    ]
    const project = SearchService.project(paginatedQuery, aggregation)
    return project.concat(aggregation)
  }

  /**
   * Create sort stage of aggregation pipeline
   * @param paginatedQuery
   * @private
   */
  private createSortStage(paginatedQuery: PaginatedQuery) {
    const { sortKey, sortOrder } = paginatedQuery
    if (sortKey) {
      const order = sortOrder === "desc" ? -1 : 1
      return [{ $sort: { [sortKey]: order } }]
    }
    return []
  }

  /**
   * Create a filters for a single item property
   * @param propertyName
   * @param conditions
   * @private
   */
  private createPropertyFilter(
    propertyName: string,
    conditions: PropertyCondition[],
  ) {
    if (conditions.length === 0) {
      return {}
    }
    if (!Array.isArray(conditions))
      throw new BadRequestException(
        `Conditions for ${propertyName} must be an array`,
      )
    // AND criteria
    const andConditions = conditions.filter(
      (condition) => condition.required && condition.required === true,
    )
    // OR criteria
    const orConditions = conditions.filter((condition) => !condition.required)
    return {
      $and: [
        this.createFilterGroup(propertyName, andConditions, true),
        this.createFilterGroup(propertyName, orConditions),
      ],
    }
  }

  /**
   * Crearte filter AND or OR group
   * @param propertyName
   * @param conditions
   * @param useAndCondition
   * @private
   */
  private createFilterGroup(
    propertyName: string,
    conditions: PropertyCondition[],
    useAndCondition = false,
  ) {
    if (conditions.length === 0) return {}
    const filters = conditions.map((condition) => {
      return this.createPropertyFilterRow(propertyName, condition)
    })
    return {
      [useAndCondition ? "$and" : "$or"]: filters,
    }
  }

  /**
   * Create a filter for a row
   * @param propertyName
   * @param condition
   * @private
   */
  private createPropertyFilterRow(
    propertyName: string,
    condition: PropertyCondition,
  ) {
    const { value, matchMode, property: objectPropertyName } = condition
    if (!value)
      throw new BadRequestException(
        `Property ${propertyName}: Filter Value is required`,
      )
    if (!matchMode)
      throw new BadRequestException(
        `Property ${propertyName}: Filter matchMode is required`,
      )
    if (matchMode === MatchMode.contains) {
      if (!Array.isArray(value))
        return { [propertyName]: { $regex: value, $options: "i" } }
      return {
        $or: value.map((item) => {
          return { [propertyName]: { $regex: item, $options: "i" } }
        }),
      }
    } else if (matchMode === MatchMode.notEquals) {
      if (!Array.isArray(value)) return { [propertyName]: { $ne: value } }
      return {
        $or: value.map((item) => {
          return { [propertyName]: { $ne: item } }
        }),
      }
    } else if (matchMode === MatchMode.greaterThan) {
      // greater than a value
      if (!Array.isArray(value)) return { [propertyName]: { $gt: value } }
      return {
        $or: value.map((item) => {
          return { [propertyName]: { $gt: item } }
        }),
      }
    } else if (matchMode === MatchMode.greaterThanOrEqual) {
      // greater than or equal to a value
      if (!Array.isArray(value)) return { [propertyName]: { $gte: value } }
      return {
        $or: value.map((item) => {
          return { [propertyName]: { $gte: item } }
        }),
      }
    } else if (matchMode === MatchMode.lessThan) {
      // less than a value
      if (!Array.isArray(value)) return { [propertyName]: { $lt: value } }
      return {
        $or: value.map((item) => {
          return { [propertyName]: { $lt: item } }
        }),
      }
    } else if (matchMode === MatchMode.lessThanOrEqual) {
      // less than or equal to a value
      if (!Array.isArray(value)) return { [propertyName]: { $lte: value } }
      return {
        $or: value.map((item) => {
          return { [propertyName]: { $lte: item } }
        }),
      }
    } else if (matchMode === MatchMode.equals) {
      if (!Array.isArray(value)) {
        if (mongoose.isValidObjectId(value) && this.IsValidHexString(value))
          return {
            [propertyName]: new mongoose.Types.ObjectId(<string>value),
          }
        else return { [propertyName]: value }
      }
      return {
        $or: value.map((item) => {
          if (
            mongoose.isValidObjectId(item) &&
            this.IsValidHexString(item as string)
          )
            return {
              [propertyName]: new mongoose.Types.ObjectId(<string>item),
            }
          else return { [propertyName]: item }
        }),
      }
    } else if (matchMode === MatchMode.between) {
      // between two array values
      if (!Array.isArray(value))
        throw new BadRequestException(
          `Property ${propertyName}: between matchMode requires array value`,
        )
      return {
        [propertyName]: { $gte: value[0], $lte: value[1] },
      }
    } else if (matchMode === MatchMode.arrayContains) {
      // Array contains value
      // In array contents we allow only strings and IDs
      let filter: (string | mongoose.Types.ObjectId)[] = Array.isArray(value)
        ? (value as string[])
        : [value as string]

      Logger.debug(
        JSON.stringify({ searchFilter: filter }, null, 2),
        "SearchEngine",
      )

      filter = filter.map((item) => {
        if (
          mongoose.isValidObjectId(item) &&
          this.IsValidHexString(item?.toString() as string)
        )
          return new mongoose.Types.ObjectId(<string>item)
        else return item
      })

      Logger.debug(
        JSON.stringify({ searchFilter: filter }, null, 2),
        "SearchEngine",
      )

      return { [propertyName]: { $in: filter } }
    } else if (matchMode === MatchMode.arrayContainsObject) {
      // Array contains object with property
      let filter: (string | mongoose.Types.ObjectId)[] = Array.isArray(value)
        ? (value as string[])
        : [value as string]

      filter = filter.map((item) =>
        mongoose.isValidObjectId(item) &&
        this.IsValidHexString(item?.toString() as string)
          ? new mongoose.Types.ObjectId(<string>item)
          : item,
      )

      return {
        [propertyName]: {
          $elemMatch: { [objectPropertyName]: { $in: filter } },
        },
      }
    } else if (matchMode === MatchMode.exists) {
      if (!Array.isArray(value)) return { [propertyName]: { $exists: value } }
      return {
        $or: value.map((item) => {
          return { [propertyName]: { $exists: item } }
        }),
      }
    } else {
      throw new BadRequestException(
        `Property ${propertyName}: Unknown match mode: ${matchMode}`,
      )
    }
    return {}
  }

  /**
   * Create a Quick filter row
   * @param propertyName
   * @param value
   * @private
   */
  private createQuickPropertyFilterRow(propertyName: string, value: string) {
    return { [propertyName]: { $regex: value, $options: "i" } }
  }

  /**
   * Paginate helper function
   * @param model
   * @param aggregations
   * @param paginationOptions
   */
  async paginate(
    model: AggregatePaginateModel<any>,
    aggregations: any[],
    paginationOptions: PaginationOptions,
  ) {
    const aggregated = model.aggregate(aggregations, { allowDiskUse: true })
    return model.aggregatePaginate(aggregated, paginationOptions)
  }

  /**
   * Count filter values
   * @param model
   * @param aggregations
   */
  async count(model: AggregatePaginateModel<any>, aggregations: any[]) {
    const aggregated = await model.aggregate(aggregations)
    return { searchCount: aggregated.length }
  }

  async rawAggregate(model: AggregatePaginateModel<any>, aggregations: any[]) {
    return model.aggregate(aggregations, { allowDiskUse: true })
  }

  /**
   * Return paginated data or count
   * @param model
   * @param aggregations
   * @param paginationOptions
   * @param count
   */
  async paginateOrCount(
    model: AggregatePaginateModel<any>,
    aggregations: any[],
    paginationOptions: PaginationOptions,
    count: boolean,
  ) {
    if (count) return this.count(model, aggregations)
    return this.paginate(model, aggregations, paginationOptions)
  }

  /**
   * Create aggregation and execute query
   *
   * @param model
   * @param paginatedQuery
   * @param lookup
   * @param countOnly
   * @param append
   * @param appendPostCondition
   * @param ignorePagination
   */
  async search(
    model: AggregatePaginateModel<any>,
    paginatedQuery: PaginatedQuery,
    lookup: any[],
    countOnly = false,
    append: AdditionalCondition = null,
    appendPostCondition: AdditionalPostCondition = null,
    ignorePagination = false,
  ): Promise<
    { searchCount: number } | mongoose.AggregatePaginateResult<any> | any[]
  > {
    const { offset, page, limit } = paginatedQuery

    const aggregations = this.createAggregation(
      paginatedQuery,
      lookup,
      append,
      appendPostCondition,
      ignorePagination,
    )
    Logger.debug(JSON.stringify(aggregations, null, 2))
    const options = {
      // populate,
      ...(offset && { offset: offset }),
      ...(page && { page: page }),
      limit,
    }
    if (ignorePagination) return this.rawAggregate(model, aggregations)
    return this.paginateOrCount(model, aggregations, options, countOnly)
  }

  /**
   * Create lookup
   * @param from
   * @param localField
   * @param foreignField
   * @param as
   * @param nestedPipeline
   * @param project
   */
  static createLookup(
    from: string,
    localField: string,
    foreignField: any,
    as: string,
    nestedPipeline: any[] = null,
    project: string | any = null,
    isArray = false,
  ): mongoose.PipelineStage[] {
    return [
      {
        $lookup: {
          from: from,
          localField: localField,
          foreignField: foreignField,
          ...((project || nestedPipeline) && {
            pipeline: [
              ...(nestedPipeline || []),
              ...(project
                ? [
                    {
                      $project: project,
                    },
                  ]
                : []),
            ],
          }),
          as: as,
        },
      },
      ...(isArray
        ? []
        : [
            {
              $set: {
                [as]: { $arrayElemAt: [`$${as}`, 0] },
              },
            },
          ]),
    ]
  }

  /**
   * Lookup
   * @param from
   * @param localField
   * @param foreignField
   * @param as
   * @param query
   * @param fieldPath
   * @param isArray
   */
  static lookup(
    from: string,
    localField: string,
    foreignField: any,
    as: string,
    query: PaginatedQuery = null,
    fieldPath: string = null,
    isArray = false,
  ) {
    return SearchService.lookupWithNestedPipeline(
      from,
      localField,
      foreignField,
      as,
      null,
      query,
      fieldPath,
      isArray,
    )
  }

  /**
   * Lookup with nested pipeline
   * @param from
   * @param localField
   * @param foreignField
   * @param as
   * @param nestedPipeline
   * @param query
   * @param fieldPath
   * @param isArray
   */
  static lookupWithNestedPipeline(
    from: string,
    localField: string,
    foreignField: any,
    as: string,
    nestedPipeline: mongoose.PipelineStage[],
    query: PaginatedQuery = null,
    fieldPath: string = null,
    isArray = false,
  ) {
    if (!query?.select)
      // we don't have select fields specified
      // extract all fields
      return SearchService.createLookup(
        from,
        localField,
        foreignField,
        as,
        nestedPipeline,
        null,
        isArray,
      )

    // we have select fields (columns) specified
    // check if we need to construct this lookup
    const columnPrefix = fieldPath ? `${fieldPath}.` : `${as}.`

    // Get regular (select) fields
    let fields = query.select
      .filter(
        (field) =>
          field.externalDocument === true &&
          field.field.startsWith(columnPrefix),
      )
      .map((field) => field.field.substring(columnPrefix.length))

    const nestedCollection: string[] = []
    if (nestedPipeline && nestedPipeline.length > 0) {
      for (const stage of nestedPipeline) {
        if ((stage as any)["$lookup"] && (stage as any)["$lookup"]["as"])
          nestedCollection.push((stage as any)["$lookup"]["as"])
      }
    }

    // Check if select list contains fields from nestedPipeline,
    const fixNested = (nestedCollections: string[], fieldName: string) => {
      for (const collection of nestedCollections) {
        if (fieldName.startsWith(collection)) return collection
      }
      return fieldName
    }

    // Get filter fields (used in filter criteria)
    const filterFields = SearchService.getFilterFields(query.query)
      .filter((field) => field.startsWith(columnPrefix))
      .map((field) => field.substring(columnPrefix.length))

    // Merge fields
    fields = fields.concat(filterFields)

    // replace nexted collection fields with collection names
    fields = fields.map((item) => fixNested(nestedCollection, item))

    if (fields && fields.length > 0) {
      // we got some fields, generate lookup
      return SearchService.createLookup(
        from,
        localField,
        foreignField,
        as,
        nestedPipeline,
        fields.reduce((o, field) => ({ ...o, [field]: 1 }), {}),
        isArray,
      )
    } else {
      // return empty step
      return []
    }
  }

  /**
   * Generate main project statement
   *
   * @param query
   * @param aggregation
   */
  static project(
    query: PaginatedQuery = null,
    aggregation: mongoose.PipelineStage[] = null,
  ): mongoose.PipelineStage[] {
    if (query?.select) {
      // we have select fields (columns) specified
      // check if we need to construct this lookup
      let fields = query.select
        .filter((field) => field.externalDocument !== true)
        .map((field) => field.field)
      const references = query.select
        .filter((field) => field.externalDocument === true)
        .map((field) => field.field.split(".")[0])

      // extract $lookups & object output (as) columns
      const asColumns = aggregation?.filter
        ? aggregation
            .filter((stage) => (stage as any)["$lookup"] != null)
            .map((stage) => (stage as any)["$lookup"]?.as)
        : []

      // Get filter fields (used in filter criteria)
      const filterFields = SearchService.getFilterFields(query.query).map(
        (field) => {
          if (field.includes(".")) {
            // First section contains Object name for example 'candidate.email'
            const [object] = field.split(".")
            // Check if object is in lookup (aka externalDocument)
            // and return it, for example 'candidate'
            if (asColumns.includes(object)) return object
          }
          // field dont match criteria for external,
          // assume its local and return all field
          return field
        },
      )

      // We added 'testCenter' and 'customer' fields here.
      // If they are not existing, mongodb will substitute testCenter and
      // customer fields value with 'null' and this is ok for us
      fields = fields.concat(references, filterFields, [
        "testCenter",
        "customer",
      ])
      const project = fields.reduce((o, field) => ({ ...o, [field]: 1 }), {})
      return [
        {
          $project: project,
        },
      ]
    }
    return []
  }

  private IsValidHexString(str: string) {
    if (str.length % 2 !== 0) return false
    return /^[0-9A-F]+$/i.test(str)
  }
}
