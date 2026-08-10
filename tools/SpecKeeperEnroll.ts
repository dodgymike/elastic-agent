/**
 * Redeems a one-time Spec Keeper agent-enrollment token.
 *
 * The returned enrollment recipe contains credentials that are intentionally
 * shown only once by Spec Keeper. Callers must store it in their approved
 * secret store and should not write it to the repository.
 */
export interface SpecKeeperEnrollOptions {
  /** Token from the `#token=` fragment of a Spec Keeper enrollment URL. */
  token: string;
}

export interface SpecKeeperEnrollment {
  username: string;
  password: string;
  api_base: string;
  project_slug: string;
  role: string;
  region?: string;
  client_id?: string;
  recipe: Record<string, string>;
}

/** Redeem an enrollment token and return the one-time Spec Keeper recipe. */
export default async function specKeeperEnroll({
  token,
}: SpecKeeperEnrollOptions): Promise<SpecKeeperEnrollment> {
  if (!token.trim()) throw new Error("A non-empty Spec Keeper enrollment token is required.");

  const response = await fetch(
    "https://api.spec.elasticninja.com/api/v1/agent-enrollments/redeem",
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ token: token.trim() }),
    },
  );
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Spec Keeper enrollment failed (${response.status}): ${body}`);
  }
  return JSON.parse(body) as SpecKeeperEnrollment;
}
