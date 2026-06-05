import { useFetcher, useLoaderData, useRevalidator } from "react-router";
import { prisma } from "../lib/prisma.server";
import { mapProjectsToGanttTasks } from "../lib/taskMapper";
import GanttChart from "../components/GanttChart";
import ProjectForm from "../components/ProjectForm";
import TaskForm from "../components/TaskForm";
import { useState } from "react";
import type { Route } from "./+types/gantt";

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader(_: Route.LoaderArgs) {
  const projects = await prisma.project.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      tasks: {
        where: { parentTaskId: null },
        include: {
          predecessors: true,
          children: {
            include: {
              predecessors: true,
              children: {
                include: {
                  predecessors: true,
                  children: true, // nível 3 — sem filhos adicionais
                },
              },
            },
          },
        },
      },
    },
  });

  return mapProjectsToGanttTasks(projects);
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function GanttPage() {
  const tasks = useLoaderData<typeof loader>();
  const { revalidate } = useRevalidator();

  const [projectFormOpen, setProjectFormOpen] = useState(false);
  const [taskFormOpen, setTaskFormOpen] = useState(false);

  // ── Callbacks do Gantt (arrastar / redimensionar) ─────────────────────────

  async function handleDateChange(
    task: { id: string },
    start: Date,
    end: Date
  ) {
    // Ignora a barra-fantasma do projeto
    if (task.id.startsWith("project-")) return;

    await fetch("/api/tasks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: task.id,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      }),
    });

    revalidate();
  }

  async function handleProgressChange(
    task: { id: string },
    progress: number
  ) {
    if (task.id.startsWith("project-")) return;

    await fetch("/api/tasks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: task.id, progress }),
    });

    revalidate();
  }

  // ── Callbacks dos formulários ─────────────────────────────────────────────

  function handleFormSuccess() {
    setProjectFormOpen(false);
    setTaskFormOpen(false);
    revalidate();
  }

  return (
    <div className="gantt-page">
      {/* ── Header ── */}
      <header className="gantt-page-header">
        <h1 className="gantt-page-title">Cronograma da Carteira</h1>

        <div className="gantt-page-actions">
          <button
            className="btn btn-secondary"
            onClick={() => setTaskFormOpen(true)}
            type="button"
          >
            + Tarefa
          </button>
          <button
            className="btn btn-primary"
            onClick={() => setProjectFormOpen(true)}
            type="button"
          >
            + Projeto
          </button>
        </div>
      </header>

      {/* ── Gantt ── */}
      <main className="gantt-page-main">
        <GanttChart
          tasks={tasks}
          defaultView="Week"
          onDateChange={handleDateChange}
          onProgressChange={handleProgressChange}
        />
      </main>

      {/* ── Modais ── */}
      {projectFormOpen && (
        <ProjectForm
          onSuccess={handleFormSuccess}
          onCancel={() => setProjectFormOpen(false)}
        />
      )}

      {taskFormOpen && (
        <TaskForm
          onSuccess={handleFormSuccess}
          onCancel={() => setTaskFormOpen(false)}
        />
      )}
    </div>
  );
}
