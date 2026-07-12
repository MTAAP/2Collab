export type OutlineHttpRequest = Readonly<{
  endpoint:
    | "auth.info"
    | "collections.list"
    | "documents.search"
    | "documents.info"
    | "documents.create"
    | "documents.update"
    | "documents.archive";
  accessToken: string;
  body: Readonly<Record<string, unknown>>;
}>;

export interface OutlineHttpTransport {
  request(input: OutlineHttpRequest): Promise<unknown>;
}

export function createOutlineClient(transport: OutlineHttpTransport) {
  return {
    search(accessToken: string, body: Readonly<Record<string, unknown>>) {
      return transport.request({ endpoint: "documents.search", accessToken, body });
    },
    read(accessToken: string, body: Readonly<Record<string, unknown>>) {
      return transport.request({ endpoint: "documents.info", accessToken, body });
    },
    create(accessToken: string, body: Readonly<Record<string, unknown>>) {
      return transport.request({ endpoint: "documents.create", accessToken, body });
    },
    update(accessToken: string, body: Readonly<Record<string, unknown>>) {
      return transport.request({ endpoint: "documents.update", accessToken, body });
    },
  };
}
