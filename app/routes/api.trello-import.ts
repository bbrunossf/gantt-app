// app/routes/api.trello-import.ts
import { data } from "react-router";
import type { Route } from "./+types/api.trello-import";

export async function action(_: Route.ActionArgs) {
  const res = await fetch("http://localhost:8000/trello-import", { method: "POST" });
  return data(await res.json());
}
