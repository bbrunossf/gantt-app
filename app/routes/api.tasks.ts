import { data } from "react-router";
import { prisma } from "../lib/prisma.server";
import type { Route } from "./+types/api.tasks";

// ─── GET /api/tasks?projectId=... ─────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId");

  const tasks = await prisma.task.findMany({
    where: projectId ? { projectId } : undefined,
    orderBy: { wbs: "asc" },
    include: {
      predecessors: true,
      successors: true,
    },
  });

  return data(tasks);
}

// ─── POST / PATCH / DELETE /api/tasks ────────────────────────────────────────

export async function action({ request }: Route.ActionArgs) {
  const method = request.method.toUpperCase();

  // ── POST: criar tarefa ────────────────────────────────────────────────────

  if (method === "POST") {
    const body = await request.json();
    const {
      name,
      description,
      wbs,
      projectId,
      parentTaskId,
      startDate,
      endDate,
      progress,
    } = body as {
      name: string;
      description?: string;
      wbs: string;
      projectId: string;
      parentTaskId?: string;
      startDate: string;
      endDate: string;
      progress?: number;
    };

    // Validações
    if (!name?.trim())
      return data({ error: "O campo 'name' é obrigatório." }, { status: 400 });
    if (!wbs?.trim())
      return data({ error: "O campo 'wbs' é obrigatório." }, { status: 400 });
    if (!projectId)
      return data(
        { error: "O campo 'projectId' é obrigatório." },
        { status: 400 }
      );
    if (!startDate || !endDate)
      return data(
        { error: "Os campos 'startDate' e 'endDate' são obrigatórios." },
        { status: 400 }
      );

    const start = new Date(startDate);
    const end = new Date(endDate);

    if (isNaN(start.getTime()) || isNaN(end.getTime()))
      return data({ error: "Datas inválidas." }, { status: 400 });
    if (end < start)
      return data(
        { error: "'endDate' não pode ser anterior a 'startDate'." },
        { status: 400 }
      );

    const task = await prisma.task.create({
      data: {
        name: name.trim(),
        description: description?.trim() ?? null,
        wbs: wbs.trim(),
        projectId,
        parentTaskId: parentTaskId ?? null,
        startDate: start,
        endDate: end,
        progress: progress ?? 0,
      },
    });

    return data(task, { status: 201 });
  }

  // ── PATCH: editar tarefa ──────────────────────────────────────────────────

  if (method === "PATCH") {
    const body = await request.json();
    const {
      id,
      name,
      description,
      wbs,
      parentTaskId,
      startDate,
      endDate,
      progress,
      // Dependências FS a sincronizar (opcional)
      predecessorIds,
    } = body as {
      id: string;
      name?: string;
      description?: string;
      wbs?: string;
      parentTaskId?: string | null;
      startDate?: string;
      endDate?: string;
      progress?: number;
      predecessorIds?: string[]; // substitui todas as dependências FS da tarefa
    };

    if (!id)
      return data({ error: "O campo 'id' é obrigatório." }, { status: 400 });

    // Monta payload dinâmico — só altera campos enviados
    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name.trim();
    if (description !== undefined)
      updateData.description = description?.trim() ?? null;
    if (wbs !== undefined) updateData.wbs = wbs.trim();
    if (parentTaskId !== undefined) updateData.parentTaskId = parentTaskId;
    if (progress !== undefined) updateData.progress = progress;

    if (startDate !== undefined) {
      const d = new Date(startDate);
      if (isNaN(d.getTime()))
        return data({ error: "'startDate' inválido." }, { status: 400 });
      updateData.startDate = d;
    }
    if (endDate !== undefined) {
      const d = new Date(endDate);
      if (isNaN(d.getTime()))
        return data({ error: "'endDate' inválido." }, { status: 400 });
      updateData.endDate = d;
    }

    // Atualiza tarefa e, se enviado, sincroniza dependências numa transação
    const task = await prisma.$transaction(async (tx) => {
      const updated = await tx.task.update({
        where: { id },
        data: updateData,
      });

      if (predecessorIds !== undefined) {
        // Remove todas as dependências FS existentes como successor
        await tx.taskDependency.deleteMany({
          where: { successorId: id, type: "FS" },
        });

        // Recria com os IDs enviados
        if (predecessorIds.length > 0) {
          await tx.taskDependency.createMany({
            data: predecessorIds.map((predecessorId) => ({
              predecessorId,
              successorId: id,
              type: "FS" as const,
              lagDays: 0,
            })),
          });
        }
      }

      return updated;
    });

    return data(task);
  }

  // ── DELETE: remover tarefa ────────────────────────────────────────────────

  if (method === "DELETE") {
    const body = await request.json();
    const { id } = body as { id: string };

    if (!id)
      return data({ error: "O campo 'id' é obrigatório." }, { status: 400 });

    // Dependências são removidas antes para evitar violação de FK
    await prisma.$transaction([
      prisma.taskDependency.deleteMany({
        where: { OR: [{ predecessorId: id }, { successorId: id }] },
      }),
      prisma.task.delete({ where: { id } }),
    ]);

    return data({ success: true });
  }

  return data({ error: "Método não suportado." }, { status: 405 });
}
