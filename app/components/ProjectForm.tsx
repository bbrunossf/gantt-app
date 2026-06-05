import { useState } from "react";
import FormModal from "./FormModal";

interface ProjectFormProps {
  /** Se fornecido, entra em modo de edição */
  project?: { id: string; name: string; description?: string | null };
  onSuccess: () => void;
  onCancel: () => void;
}

export default function ProjectForm({
  project,
  onSuccess,
  onCancel,
}: ProjectFormProps) {
  const isEditing = !!project;

  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(
    project?.description ?? ""
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    if (!name.trim()) {
      setError("O nome do projeto é obrigatório.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/projects", {
        method: isEditing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(isEditing && { id: project.id }),
          name: name.trim(),
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
      setLoading(false);
    }
  }

  return (
    <FormModal
      title={isEditing ? "Editar Projeto" : "Novo Projeto"}
      onCancel={onCancel}
      onConfirm={handleConfirm}
      loading={loading}
      error={error}
    >
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
          disabled={loading}
        />
      </div>

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
          disabled={loading}
        />
      </div>
    </FormModal>
  );
}
