export const conversationHref = (id: string) =>
  `/conversations/${encodeURIComponent(id)}`;
export const workHref = (source: string, id: string) =>
  `/work/${encodeURIComponent(source + ":" + id)}`;
export function legacyWorkHref(search: URLSearchParams) {
  const mission = search.get("mission"),
    task = search.get("task");
  return mission
    ? workHref("mission", mission)
    : task
      ? workHref("task", task)
      : "/settings/advanced";
}
