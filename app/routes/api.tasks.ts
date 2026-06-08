import { data } from "react-router";
import { prisma } from "../lib/prisma.server";
import type { Route } from "./+types/api.tasks";

// ─── GET /api/tasks?projectId=... ─────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const projectId = url.searchParams.get("projectId");

  const tasks = await prisma.task.findMany({
    where: projectId ? { projectId } : undefined,
    orderBy: { createdAt: "asc" },
    include: {
      // Tarefas das quais esta depende (predecessoras)
      dependencies: {
        include: {
          predecessor: { select: { id: true, name: true } },
        },
      },
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
      projectId,
      start,
      end,
      progress,
      barLabel,
      customClass,
      predecessorIds,
    } = body as {
      name: string;
      projectId: string;
      start?: string;        // opcional se houver predecessoras
      end: string;
      progress?: number;
      barLabel?: string;
      customClass?: string;
      predecessorIds?: string[];
    };

    // Validações
    if (!name?.trim())
      return data({ error: "O campo 'name' é obrigatório." }, { status: 400 });
    if (!projectId)
      return data(
        { error: "O campo 'projectId' é obrigatório." },
        { status: 400 }
      );
    if (!end)
      return data(
        { error: "O campo 'end' é obrigatório." },
        { status: 400 }
      );

    // start é obrigatório apenas se não houver predecessoras
    const hasPredecessors =
      predecessorIds && predecessorIds.length > 0;
    if (!start && !hasPredecessors)
      return data(
        { error: "O campo 'start' é obrigatório (ou selecione predecessoras)." },
        { status: 400 }
      );

    // Deriva start da maior data final das predecessoras, se não informado
    let resolvedStart: Date;
    if (start) {
      resolvedStart = new Date(start);
      if (isNaN(resolvedStart.getTime()))
        return data({ error: "'start' inválido." }, { status: 400 });
    } else if (hasPredecessors) {
      const preds = await prisma.task.findMany({
        where: { id: { in: predecessorIds } },
        select: { end: true },
      });
      if (preds.length === 0)
        return data(
          { error: "Nenhuma predecessora encontrada." },
          { status: 400 }
        );
      const latestEnd = preds.reduce((max, p) =>
        p.end > max ? p.end : max,
        preds[0].end
      );
      resolvedStart = latestEnd;
    } else {
      return data(
        { error: "O campo 'start' é obrigatório." },
        { status: 400 }
      );
    }

    const endDate = new Date(end);
    if (isNaN(endDate.getTime()))
      return data({ error: "'end' inválido." }, { status: 400 });
    if (endDate < resolvedStart)
      return data(
        { error: "'end' não pode ser anterior a 'start'." },
        { status: 400 }
      );

    // Cria tarefa e dependências em uma transação
    const task = await prisma.$transaction(async (tx) => {
      const created = await tx.task.create({
        data: {
          name: name.trim(),
          projectId,
          start: resolvedStart,
          end: endDate,
          progress: progress ?? 0,
          barLabel: barLabel?.trim() || null,
          customClass: customClass?.trim() || null,
        },
      });

      if (hasPredecessors) {
        await tx.taskDependency.createMany({
          data: predecessorIds!.map((predecessorId) => ({
            predecessorId,
            successorId: created.id,
            type: "FS" as const,
          })),
        });
      }

      return created;
    });

    return data(task, { status: 201 });
  }


  // ── PATCH: editar tarefa ──────────────────────────────────────────────────

  if (method === "PATCH") {
    const body = await request.json();
    const {
      id,
      name,
      start,
      end,
      progress,
      barLabel,
      customClass,
      predecessorIds,
    } = body as {
      id: string;
      name?: string;
      start?: string;
      end?: string;
      progress?: number;
      barLabel?: string | null;
      customClass?: string | null;
      predecessorIds?: string[];
    };

    if (!id)
      return data({ error: "O campo 'id' é obrigatório." }, { status: 400 });

    // Monta payload dinâmico — só altera campos enviados
    const updateData: Record<string, unknown> = {};
    if (name !== undefined) updateData.name = name.trim();
    if (progress !== undefined) updateData.progress = progress;
    if (barLabel !== undefined)
      updateData.barLabel = barLabel?.trim() || null;
    if (customClass !== undefined)
      updateData.customClass = customClass?.trim() || null;

    if (start !== undefined) {
      const d = new Date(start);
      if (isNaN(d.getTime()))
        return data({ error: "'start' inválido." }, { status: 400 });
      updateData.start = d;
    }
    if (end !== undefined) {
      const d = new Date(end);
      if (isNaN(d.getTime()))
        return data({ error: "'end' inválido." }, { status: 400 });
      updateData.end = d;
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

        // Recria com os IDs enviados (sem lagDays — não existe no schema)
        if (predecessorIds.length > 0) {
          await tx.taskDependency.createMany({
            data: predecessorIds.map((predecessorId) => ({
              predecessorId,
              successorId: id,
              type: "FS" as const,
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
