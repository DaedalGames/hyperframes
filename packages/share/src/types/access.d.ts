/** Read for each request, so a share that outlives a token meets the renewed one; pass a bearer a server refused.
 * `owner` is the account the token is (accountPrincipal), for what is counted per account. */
/** `orOffline`: a saved sign-in whose renewal could not reach HeyGen throws AccountUnreachable instead of null. */
export type ApiAccess = (
  refused?: string,
  orOffline?: boolean,
) => Promise<{
  token: string;
  owner: string | null;
  heygen: string;
  heygenApi: string;
  cutroomApi?: string;
} | null>;

/** Who a send went out as: the plan's person, or the key by its hash; `skip` is why a key send wasn't on the plan. */
export type By =
  | { payer: "plan"; owner: string }
  | { payer: "key"; keyHash: string; skip?: unknown };

/** The saved API key and the HeyGen API host it is sent to. With no key saved, `key` is null when the plan pays `route`
 * now, and the whole answer null otherwise or with no `route`. `owner` (ownerIdOf): who is signed in. */
export type KeyAccess = (
  route?: string,
) => Promise<
  | { key: string; heygenApi: string; owner?: string }
  | { key: null; heygenApi: string; owner: string }
  | null
>;
