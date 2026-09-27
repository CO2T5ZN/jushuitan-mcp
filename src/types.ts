/** Normalized data types shared across the server. */

export interface ParamRow {
  /** Flattened path, e.g. `data.datas[].shop_id`; `（根）` marks the biz root. */
  path: string;
  type: string;
  required: boolean;
  example: string;
  description: string;
}

export interface CommonParam {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface EnvUrl {
  env: string;
  url: string;
}

export interface ErrorCode {
  code: string;
  message: string;
  solve: string;
}

export interface CodeDemo {
  language: string;
  code: string;
}

export interface ApiDoc {
  docId: number;
  route: string;
  name: string;
  /** API 说明 (rich text converted to plain text/markdown). */
  apiDescription: string;
  urls: EnvUrl[];
  commonParams: CommonParam[];
  requestParams: ParamRow[];
  responseParams: ParamRow[];
  errors: ErrorCode[];
  requestExample: string | null;
  responseExample: string | null;
  exceptionExample: string | null;
  codeDemos: CodeDemo[];
}

export interface ApiCategory {
  id: number;
  name: string;
  ordered: number;
  apis: ApiDoc[];
}

export interface DocsData {
  fetchedAt: string;
  source: string;
  categories: ApiCategory[];
}

/** Locate an API doc with its owning category. */
export interface ResolvedApi {
  category: ApiCategory;
  doc: ApiDoc;
}
