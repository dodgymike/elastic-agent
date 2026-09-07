/** Conservative protected components shared by shell mounts and recursive reads.
 * This protects known credential/state paths, not arbitrary secrets in source.
 */
export const protectedPathComponent = /^(?:data\.json|\.env(?:\..*)?|\.git|\.agents|\.codex|\.ssh|\.aws|\.config|\.spec(?:[.-].*)?|\.agent[-.]bus.*|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_(?:rsa|ed25519|ecdsa|dsa)|memory-output|.*\.(?:pem|key|p12|pfx|sqlite|log)|(?:.*[-_.])?(?:token|tokens|api[_-]?key|apikey|password|passwd|secret|secrets|credential|credentials)(?:\.[^.]+)?)$/i;
export function isPrivatePath(path: string): boolean {
  return path.split(/[\\/]/).some((component) => protectedPathComponent.test(component));
}
