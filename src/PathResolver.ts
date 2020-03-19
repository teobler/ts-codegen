import {
  Operation,
  Parameter,
  Path,
  Paths,
  Reference,
  Response,
  Schema,
  Server,
} from "@openapi-integration/openapi-schema";
import { SchemaResolver } from "./SchemaResolver";
import { generateEnums } from "./DefinitionsResolver";
import { chain, Dictionary, drop, filter, get, isEmpty, map, pick, reduce, sortBy } from "lodash";
import { toTypes } from "./utils";
import { HTTP_METHODS, SLASH } from "./constants";

// TODO: Should handle `deprecated` and `security` in Operation?

type IResolvedPath = IParameters & {
  url: string;
  method: string;
  TResp: any;
  TReq: any;
  operationId?: string;
};

interface IParameters {
  pathParams: Parameter[];
  queryParams: Parameter[];
  bodyParams: Parameter[];
  formDataParams: Parameter[];
}

export class PathResolver {
  resolvedPaths: IResolvedPath[] = [];
  extraDefinitions = {};

  static of(paths: Paths, servers: Server[] = []) {
    return new PathResolver(paths, servers);
  }

  constructor(private paths: Paths, private servers: Server[]) {}

  resolve = () => {
    this.resolvedPaths = reduce(
      this.paths,
      (results: IResolvedPath[], path: Path, pathName: string) => [...results, ...this.resolvePath(path, pathName)],
      [],
    );
    return this;
  };

  toRequest = (): string[] => {
    const data = sortBy(this.resolvedPaths, (o) => o.operationId);
    const requests = data.map((v: IResolvedPath) => {
      const TReq = !isEmpty(v.TReq) ? toTypes(v.TReq) : undefined;
      const requestParamList = [...v.pathParams, ...v.queryParams, ...v.bodyParams, ...v.formDataParams];
      const bodyData = get(v.bodyParams, "[0]");
      const formData = get(v.formDataParams, "[0]");
      const body = bodyData || formData;
      const params = this.toRequestParams(get(v, "queryParams"));

      return `export const ${v.operationId} = createRequestAction<${TReq}, ${v.TResp}>('${v.operationId}', (${
        !isEmpty(requestParamList) ? `${this.toRequestParams(requestParamList)}` : ""
      }) => ({url: \`${v.url}\`, method: "${v.method}", ${body ? `data: ${body},` : ""}${
        params ? `params: ${params},` : ""
      }${body ? `headers: {'Content-Type': ${formData ? "'multipart/form-data'" : "'application/json'"}}` : ""}}));`;
    });

    const enums = Object.keys(this.extraDefinitions).map((k) => generateEnums(this.extraDefinitions, k));
    return [...requests, ...enums];
  };

  toRequestParams = (data: any[] = []) =>
    !isEmpty(data)
      ? `{
    ${data.join(",\n")}
    }`
      : undefined;

  resolvePath(path: Path, pathName: string) {
    const operations = pick(path, HTTP_METHODS);

    // TODO: need to do refactor
    const basePath = SLASH.concat(drop(this.servers[0].url.split(SLASH), 3).join(SLASH));

    return Object.keys(operations).map((httpMethod) => {
      const requestPath = this.getRequestURL(pathName);

      return {
        url: `${basePath}${requestPath === SLASH && !!basePath ? "" : requestPath}`,
        method: httpMethod,
        ...this.resolveOperation((operations as Dictionary<any>)[httpMethod]),
      };
    });
  }

  getRequestURL = (pathName: string) => {
    return chain(pathName)
      .split(SLASH)
      .map((p) => (this.isPathParam(p) ? `$${p}` : p))
      .join(SLASH)
      .value();
  };

  isPathParam = (str: string) => str.startsWith("{");

  // TODO: handle the case when v.parameters = Reference
  resolveOperation = (operation: Operation) => {
    const pickParamsByType = this.pickParams(operation.parameters as Parameter[]);
    const params = {
      pathParams: pickParamsByType("path"),
      queryParams: pickParamsByType("query"),
      bodyParams: pickParamsByType("body"),
      formDataParams: pickParamsByType("cookie"),
    };

    return {
      operationId: operation.operationId,
      TResp: this.getResponseTypes(operation.responses),
      TReq: this.getRequestTypes(params),
      ...this.getParamsNames(params),
    };
  };

  getParamsNames = (params: IParameters) => {
    const getNames = (list: any[]) => (isEmpty(list) ? [] : map(list, (item) => item.name));
    return {
      pathParams: getNames(params.pathParams),
      queryParams: getNames(params.queryParams),
      bodyParams: getNames(params.bodyParams),
      formDataParams: getNames(params.formDataParams),
    };
  };

  getRequestTypes = (params: IParameters) => ({
    ...this.getPathParamsTypes(params.pathParams),
    ...this.getQueryParamsTypes(params.queryParams),
    ...this.getBodyParamsTypes(params.bodyParams),
    ...this.getFormDataParamsTypes(params.formDataParams),
  });

  getPathParamsTypes = (pathParams: Parameter[]) =>
    pathParams.reduce(
      (results, param) => ({
        ...results,
        [`${param.name}${param.required ? "" : "?"}`]: param.type === "integer" ? "number" : param.type,
      }),
      {},
    );

  getBodyParamsTypes = (bodyParams: Parameter[]) =>
    bodyParams.reduce(
      (o, v) => ({
        ...o,
        [`${v.name}${v.required ? "" : "?"}`]: SchemaResolver.of({
          results: this.extraDefinitions,
          schema: v.schema,
          key: v.name,
          parentKey: v.name,
        }).resolve(),
      }),
      {},
    );

  getQueryParamsTypes = (queryParams: Parameter[]) =>
    queryParams.reduce(
      (o, v) => ({
        ...o,
        [`${v.name}${v.required ? "" : "?"}`]: SchemaResolver.of({
          results: this.extraDefinitions,
          schema: v as Schema,
          key: v.name,
          parentKey: v.name,
        }).resolve(),
      }),
      {},
    );

  // TODO: handle other params here?
  getFormDataParamsTypes = (formDataParams: any[]) => {
    return formDataParams.reduce((results, param) => {
      if (param.schema) {
        return {
          ...results,
          [`${param.name}${param.required ? "" : "?"}`]: SchemaResolver.of({
            results: this.extraDefinitions,
            schema: param.schema,
            key: param.name,
            parentKey: param.name,
          }).resolve(),
        };
      }
      return {
        ...results,
        [`${param.name}${param.required ? "" : "?"}`]: param.type === "file" ? "File" : param.type,
      };
    }, {});
  };

  // TODO: handle Response or Reference
  getResponseTypes = (responses: { [responseName: string]: Response | Reference }) =>
    SchemaResolver.of({
      results: this.extraDefinitions,
      schema: get(responses, "200.schema") || get(responses, "201.schema"),
    }).resolve();

  // TODO: when parameters has enum
  pickParams = (parameters: Parameter[]) => (type: "path" | "query" | "body" | "cookie") =>
    filter(parameters, (param) => param.in === type);
}
