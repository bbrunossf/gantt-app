import { useState } from "react";
import FormModal from "./FormModal";

// ─── Tipos ────────────────────────────────────────────────────────────────────

/** Alinhado com o model `Project` do Prisma schema */
interface ProjectFormData {
  id: string;
  name: string;
  codObra: string | null;
  description: string | null;
  createdAt: string; // retornado pela API GET, mas não editável
  // updatedAt é gerenciado automaticamente pelo Prisma (@updatedAt)
}

interface ProjectFormProps {
  /** Se fornecido, entra em modo de edição */
  project?: ProjectFormData;
  onSuccess: () => void;
  onCancel: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

// ─── Componente ───────────────────────────────────────────────────────────────

export default function ProjectForm({
  project,
  onSuccess,
  onCancel,
}: ProjectFormProps) {
  const isEditing = !!project;

  // Campos do formulário
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(
    project?.description ?? ""
  );
  const [codObra, setCodObra] = useState(project?.codObra ?? "");


  // Estado do form
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Submit ──────────────────────────────────────────────────────────────

  async function handleConfirm() {
    setError(null);

    if (!name.trim()) {
      return setError("O nome do projeto é obrigatório.");
    }

    setSaving(true);

    try {
      const res = await fetch("/api/projects", {
        method: isEditing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(isEditing && { id: project!.id }),
          name: name.trim(),
          codObra: codObra.trim() || null,
          description: description.trim() || null,
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Erro ao salvar projeto.");
      }

      onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Erro inesperado.");
    } finally {
      setSaving(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <FormModal
      title={isEditing ? "Editar Projeto" : "Novo Projeto"}
      onCancel={onCancel}
      onConfirm={handleConfirm}
      loading={saving}
      error={error}
    >
      {/* Nome */}
      <div className="form-field">
        <label className="form-label" htmlFor="project-name">
          Nome <span className="form-required">*</span>
        </label>
        <input
          id="project-name"
          className="form-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex: Edifício Comercial Centro"
          autoFocus
          disabled={saving}
        />
      </div>

      {/* Código da Obra */}
      <div className="form-field">
        <label className="form-label" htmlFor="project-codobra">
          Código da Obra
        </label>
        <input
          id="project-codobra"
          className="form-input"
          type="text"
          value={codObra}
          onChange={(e) => setCodObra(e.target.value)}
          placeholder="Ex: OBRA-001"
          disabled={saving}
        />
      </div>


      {/* Descrição */}
      <div className="form-field">
        <label className="form-label" htmlFor="project-description">
          Descrição
        </label>
        <textarea
          id="project-description"
          className="form-input form-textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Descrição opcional do projeto"
          rows={3}
          disabled={saving}
        />
      </div>

      {/* Criado em (somente-leitura no modo edição) */}
      {isEditing && project.createdAt && (
        <div className="form-field">
          <label className="form-label">Criado em</label>
          <p className="form-static">{formatDate(project.createdAt)}</p>
        </div>
      )}
    </FormModal>
  );
}
