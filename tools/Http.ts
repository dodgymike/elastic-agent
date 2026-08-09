export default interface HttpResult {
  response: Response;
  body: string;
}

export default interface HttpOption {
  url: string,
}

/** Calls a URL and returns both the HTTP response and its text body. */
export default async function http({ url }: HttpOption): Promise<HttpResult> {
  const response = await fetch(url);
  const body = await response.text();

  return { response, body };
}
