import { useCallback, useMemo, useRef, useEffect, useState } from "react";
import { useLoaderData, useRevalidator } from "react-router";
import { prisma } from "../lib/prisma.server";
import { mapProjectsToGanttTasks } from "../lib/taskMapper";
import GanttChart from "../components/GanttChart";
import ProjectForm from "../components/ProjectForm";
import TaskForm from "../components/TaskForm";
import type { Route } from "./+types/gantt";

// ─── Loader ───────────────────────────────────────────────────────────────────

export async function loader(_: Route.LoaderArgs) {
  const projects = await prisma.project.findMany({
    orderBy: { codObra: "asc" },
    include: {
      tasks: {
        where: { OR: [
           { trelloSyncStatus: null },      // tarefas manuais
           { trelloSyncStatus: "active" },  // tarefas sincronizadas ativas
         ]},
        orderBy: { createdAt: "asc" },
        include: {
          dependencies: {
            where: { type: "FS" },
            select: { predecessorId: true },
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
  const [importing, setImporting] = useState(false);

  // ── Filtro de projetos ─────────────────────────────────────────────────────

  // Lista única de projetos (extraída das barras-fantasma)
  const allProjects = useMemo(() => {
    const map = new Map<string, string>(); // projectId → projectName
    for (const t of tasks) {
      if (t.id.startsWith("project-") && t.projectId) {
        map.set(t.projectId, t.name);
      }
    }
    return [...map.entries()]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [tasks]);

  const [selectedProjects, setSelectedProjects] = useState<Set<string>>(
    new Set()
  );

  const [projectDropdownOpen, setProjectDropdownOpen] = useState(false);
  const projectDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        projectDropdownRef.current &&
        !projectDropdownRef.current.contains(e.target as Node)
      ) {
        setProjectDropdownOpen(false);
      }
    }
    if (projectDropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [projectDropdownOpen]);



  // ── Filtro de recursos ───────────────────────────────────────────────────

  // Lista única de todos os recursos, ordenada
  const allResources = useMemo(
    () =>
      [...new Set(tasks.filter((t) => t.resource).map((t) => t.resource!))].sort(
        (a, b) => a.localeCompare(b)
      ),
    [tasks]
  );

  // Conjunto de recursos selecionados (vazio = mostrar todos)
  const [selectedResources, setSelectedResources] = useState<Set<string>>(
    new Set()
  );

  // Tarefas filtradas por recurso ou por projeto: sempre inclui as barras de projeto
  const filteredTasks = useMemo(() => {
    return tasks.filter((t) => {
      const isProjectBar = t.id.startsWith("project-");

      // Filtro de projetos: vazio = todos
      const passesProjectFilter =
        selectedProjects.size === 0 ||
        (t.projectId && selectedProjects.has(t.projectId));

      if (!passesProjectFilter) return false;

      // Filtro de recursos: vazio = todos; barras de projeto sempre passam
      const passesResourceFilter =
        selectedResources.size === 0 ||
        isProjectBar ||
        (t.resource && selectedResources.has(t.resource));

      return passesResourceFilter;
    });
  }, [tasks, selectedResources, selectedProjects]);


  // Estado de abertura do dropdown
  const [resourceDropdownOpen, setResourceDropdownOpen] = useState(false);
  const resourceDropdownRef = useRef<HTMLDivElement>(null);

  // Fecha o dropdown ao clicar fora
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (
        resourceDropdownRef.current &&
        !resourceDropdownRef.current.contains(e.target as Node)
      ) {
        setResourceDropdownOpen(false);
      }
    }
    if (resourceDropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [resourceDropdownOpen]);



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
        start: start.toISOString(),
        end: end.toISOString(),
      }),
    });

    //revalidate();
  }

  // async function handleProgressChange(
  //   task: { id: string },
  //   progress: number
  // ) {
  //   if (task.id.startsWith("project-")) return;

  //   await fetch("/api/tasks", {
  //     method: "PATCH",
  //     headers: { "Content-Type": "application/json" },
  //     body: JSON.stringify({ id: task.id, progress }),
  //   });

  //   revalidate();
  // }

  // -- Importação de dados do Trello
  async function handleTrelloImport() {
    setImporting(true);
    try {
      const res = await fetch("/api/trello-import", { method: "POST" });
      const result = await res.json();

      // 2. Sincroniza progresso dos projetos
      const progRes = await fetch("/api/sync-progress", { method: "POST" });
      const progData = await progRes.json();

      const msg = [
        `Importado: ${result.created} criadas, ${result.updated} atualizadas, ${result.orphaned} órfãs.`,
        `Progresso: ${progData.updated} projetos atualizados.`,
        ...(progData.warnings?.length
          ? [`\nAlertas:\n${progData.warnings.join("\n")}`]
          : []),
      ].join("\n");

      alert(msg); //deixar por enquanto


      revalidate();
    } finally {
      setImporting(false);
    }
  }

  // ── Callback de dependência (popup do Gantt) ─────────────────────────────

  async function handleAddDependency(taskId: string, predecessorId: string) {
    // Encontra a task para obter as dependências atuais
    const task = tasks.find((t) => t.id === taskId);
    const existingDeps = task?.dependencies
      ? task.dependencies.split(",").filter(Boolean)
      : [];

    // Evita duplicata
    if (existingDeps.includes(predecessorId)) return;

    const mergedDeps = [...existingDeps, predecessorId];

    await fetch("/api/tasks", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: taskId, predecessorIds: mergedDeps }),
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

        {/* ── Filtro de recursos ── */}
        {allResources.length > 0 && (
          <div className="resource-filter" ref={resourceDropdownRef}>
            <button
              className="resource-filter-trigger"
              onClick={() => setResourceDropdownOpen((o) => !o)}
              type="button"
            >
              Recursos
              {selectedResources.size > 0 && (
                <span className="resource-filter-badge">{selectedResources.size}</span>
              )}
              <span className="resource-filter-arrow">▾</span>
            </button>

            {resourceDropdownOpen && (
              <div className="resource-filter-dropdown">
                <label className="resource-filter-option">
                  <input
                    type="checkbox"
                    checked={selectedResources.size === 0}
                    onChange={() => setSelectedResources(new Set())}
                  />
                  <span>Todos</span>
                </label>

                {allResources.length > 0 && (
                  <div className="resource-filter-divider" />
                )}

                {allResources.map((r) => (
                  <label key={r} className="resource-filter-option">
                    <input
                      type="checkbox"
                      checked={selectedResources.has(r)}
                      onChange={() => {
                        setSelectedResources((prev) => {
                          const next = new Set(prev);
                          if (next.has(r)) {
                            next.delete(r);
                          } else {
                            next.add(r);
                          }
                          // Se todos ficarem selecionados, limpa (equivale a "Todos")
                          return next.size === allResources.length
                            ? new Set()
                            : next;
                        });
                      }}
                    />
                    <span>{r}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Filtro de projetos ── */}
        {allProjects.length > 0 && (
          <div className="resource-filter" ref={projectDropdownRef}>
            <button
              className="resource-filter-trigger"
              onClick={() => setProjectDropdownOpen((o) => !o)}
              type="button"
            >
              Projetos
              {selectedProjects.size > 0 && (
                <span className="resource-filter-badge">{selectedProjects.size}</span>
              )}
              <span className="resource-filter-arrow">▾</span>
            </button>

            {projectDropdownOpen && (
              <div className="resource-filter-dropdown">
                <label className="resource-filter-option">
                  <input
                    type="checkbox"
                    checked={selectedProjects.size === 0}
                    onChange={() => setSelectedProjects(new Set())}
                  />
                  <span>Todos</span>
                </label>

                {allProjects.length > 0 && (
                  <div className="resource-filter-divider" />
                )}

                {allProjects.map((p) => (
                  <label key={p.id} className="resource-filter-option">
                    <input
                      type="checkbox"
                      checked={selectedProjects.has(p.id)}
                      onChange={() => {
                        setSelectedProjects((prev) => {
                          const next = new Set(prev);
                          if (next.has(p.id)) {
                            next.delete(p.id);
                          } else {
                            next.add(p.id);
                          }
                          return next.size === allProjects.length
                            ? new Set()
                            : next;
                        });
                      }}
                    />
                    <span>{p.name}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}



        <div className="gantt-page-actions">
          <button className="btn btn-trello" onClick={handleTrelloImport} disabled={importing}>
            {importing ? "Importando..." : "Importar Trello"}
          </button>

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
          // tasks={tasks}
          tasks={filteredTasks}
          defaultView="Week"
          onDateChange={handleDateChange}
          onAddDependency={handleAddDependency}
          onTaskUpdated={() => revalidate()}
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
