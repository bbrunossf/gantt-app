import { data } from "react-router";
import type { Route } from "./+types/api.sync-progress";

export async function action(_: Route.ActionArgs) {
  const res = await fetch("http://localhost:8001/sync-progress", {
    method: "POST",
  });
  return data(await res.json());
}
