export function postLoginDestination(hostname: string): string {
  return hostname.split(".")[0] === "admin" ? "/" : "/organisations";
}
