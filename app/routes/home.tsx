// app/routes/home.tsx
import { redirect } from "react-router";
import type { Route } from "./+types/home";

export function loader(_: Route.LoaderArgs) {
  return redirect("/gantt");
}

export default function Home() {
  return null;
}
