import { DynamicModule, Module } from "@nestjs/common"
import { MongooseSearchService } from "./mongoose-search.service"

@Module({})
export class MongooseSearchModule {
  static register(): DynamicModule {
    return {
      module: MongooseSearchModule,
      providers: [MongooseSearchService],
      exports: [MongooseSearchService],
    }
  }
}
