import { type RouteConfig, index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("gantt",           "routes/gantt.tsx"),
  route("api/projects",    "routes/api.projects.ts"),
  route("api/tasks", "routes/api.tasks.ts"),
  route("api/trello-import", "routes/api.trello-import.ts"),
] satisfies RouteConfig;
