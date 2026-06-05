import { data } from "react-router";
import { prisma } from "../lib/prisma.server";
import type { Route } from "./+types/api.projects";

// ─── GET /api/projects ────────────────────────────────────────────────────────

export async function loader({ request }: Route.LoaderArgs) {
  const projects = await prisma.project.findMany({
    orderBy: { createdAt: "asc" },
    select: { id: true, name: true, description: true, createdAt: true },
  });

  return data(projects);
}

// ─── POST / PATCH / DELETE /api/projects ──────────────────────────────────────

export async function action({ request }: Route.ActionArgs) {
  const method = request.method.toUpperCase();

  // ── POST: criar projeto ───────────────────────────────────────────────────

  if (method === "POST") {
    const body = await request.json();
    const { name, description } = body as {
      name: string;
      description?: string;
    };

    if (!name?.trim()) {
      return data({ error: "O campo 'name' é obrigatório." }, { status: 400 });
    }

    const project = await prisma.project.create({
      data: { name: name.trim(), description: description?.trim() ?? null },
    });

    return data(project, { status: 201 });
  }

  // ── PATCH: editar projeto ─────────────────────────────────────────────────

  if (method === "PATCH") {
    const body = await request.json();
    const { id, name, description } = body as {
      id: string;
      name?: string;
      description?: string;
    };

    if (!id) {
      return data({ error: "O campo 'id' é obrigatório." }, { status: 400 });
    }

    const project = await prisma.project.update({
      where: { id },
      data: {
        ...(name !== undefined && { name: name.trim() }),
        ...(description !== undefined && {
          description: description?.trim() ?? null,
        }),
      },
    });

    return data(project);
  }

  // ── DELETE: remover projeto ───────────────────────────────────────────────

  if (method === "DELETE") {
    const body = await request.json();
    const { id } = body as { id: string };

    if (!id) {
      return data({ error: "O campo 'id' é obrigatório." }, { status: 400 });
    }

    // As tarefas são removidas em cascata (onDelete: Cascade no schema)
    await prisma.project.delete({ where: { id } });

    return data({ success: true });
  }

  return data({ error: "Método não suportado." }, { status: 405 });
}
