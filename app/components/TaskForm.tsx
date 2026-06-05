import { useEffect, useState } from "react";
import FormModal from "./FormModal";

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface ProjectOption {
  id: string;
  name: string;
}

interface TaskOption {
  id: string;
  name: string;
  wbs: string;
}

interface TaskFormProps {
  /** Se fornecido, entra em modo de edição */
  task?: {
    id: string;
    name: string;
    description?: string | null;
    wbs: string;
    projectId: string;
    parentTaskId?: string | null;
    startDate: string;
    endDate: string;
    progress: number;
    predecessorIds?: string[];
  };
  onSuccess: () => void;
  onCancel: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toInputDate(iso: string): string {
  return iso.slice(0, 10);
}

function wbsDepth(wbs: string): number {
  return wbs.split(".").length;
}

// ─── Componente ───────────────────────────────────────────────────────────────

export default function TaskForm({ task, onSuccess, onCancel }: TaskFormProps) {
  const isEditing = !!task;

  // Campos do formulário
  const [name, setName] = useState(task?.name ?? "");
  const [description, setDescription] = useState(task?.description ?? "");
  const [wbs, setWbs] = useState(task?.wbs ?? "");
  const [projectId, setProjectId] = useState(task?.projectId ?? "");
  const [parentTaskId, setParentTaskId] = useState(
    task?.parentTaskId ?? ""
  );
  const [startDate, setStartDate] = useState(
    task ? toInputDate(task.startDate) : ""
  );
  const [endDate, setEndDate] = useState(
    task ? toInputDate(task.endDate) : ""
  );
  const [progress, setProgress] = useState(task?.progress ?? 0);
  const [predecessorIds, setPredecessorIds] = useState<string[]>(
    task?.predecessorIds ?? []
  );

  // Dados remotos
  const [projects, setProjects] = useState<ProjectOption[]>([]);
  const [availableTasks, setAvailableTasks] = useState<TaskOption[]>([]);
  const [loadingData, setLoadingData] = useState(true);

  // Estado do form
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ── Carrega projetos ao montar ──────────────────────────────────────────

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data: ProjectOption[]) => {
        setProjects(data);
        // Se só houver um projeto, pré-seleciona
        if (!isEditing && data.length === 1) setProjectId(data[0].id);
      })
      .finally(() => setLoadingData(false));
  }, []);

  // ── Carrega tarefas disponíveis quando projectId muda ──────────────────

  useEffect(() => {
    if (!projectId) {
      setAvailableTasks([]);
      setParentTaskId("");
      setPredecessorIds([]);
      return;
    }

    fetch(`/api/tasks?projectId=${projectId}`)
      .then((r) => r.json())
      .then((data: TaskOption[]) => {
        // Exclui a própria tarefa em edição e seus descendentes
        const filtered = isEditing
          ? data.filter((t) => t.id !== task.id)
          : data;
        setAvailableTasks(filtered);
      });
  }, [projectId]);

  // ── Tarefas elegíveis como pai (máx. nível 2 para respeitar 3 níveis) ──

  const parentOptions = availableTasks.filter((t) => wbsDepth(t.wbs) <= 2);

  // ── Toggle de predecessor ───────────────────────────────────────────────

  function togglePredecessor(id: string) {
    setPredecessorIds((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id]
    );
  }

  // ── Submit ──────────────────────────────────────────────────────────────

  async function handleConfirm() {
    setError(null);

    if (!name.trim()) return setError("O nome é obrigatório.");
    if (!wbs.trim()) return setError("O WBS é obrigatório.");
    if (!projectId) return setError("Selecione um projeto.");
    if (!startDate) return setError("A data de início é obrigatória.");
    if (!endDate) return setError("A data de término é obrigatória.");
    if (endDate < startDate)
      return setError("O término não pode ser anterior ao início.");
    if (progress < 0 || progress > 100)
      return setError("O progresso deve estar entre 0 e 100.");

    setSaving(true);

    try {
      const res = await fetch("/api/tasks", {
        method: isEditing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(isEditing && { id: task.id }),
          name: name.trim(),
          description: description.trim() || null,
          wbs: wbs.trim(),
          projectId,
          parentTaskId: parentTaskId || null,
          startDate,
          endDate,
          progress,
          predecessorIds,
        }),
      });

      if (!res.ok) {
        const body = await res.json();
        throw new Error(body.error ?? "Erro ao salvar tarefa.");
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
      title={isEditing ? "Editar Tarefa" : "Nova Tarefa"}
      onCancel={onCancel}
      onConfirm={handleConfirm}
      loading={saving || loadingData}
      error={error}
    >
      {/* Nome */}
      <div className="form-field">
        <label className="form-label" htmlFor="task-name">
          Nome <span className="form-required">*</span>
        </label>
        <input
          id="task-name"
          className="form-input"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ex: Fundações"
          autoFocus
          disabled={saving}
        />
      </div>

      {/* Projeto + WBS (linha dupla) */}
      <div className="form-row">
        <div className="form-field form-field--grow">
          <label className="form-label" htmlFor="task-project">
            Projeto <span className="form-required">*</span>
          </label>
          <select
            id="task-project"
            className="form-input form-select"
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            disabled={saving || loadingData}
          >
            <option value="">Selecione…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>

        <div className="form-field form-field--wbs">
          <label className="form-label" htmlFor="task-wbs">
            WBS <span className="form-required">*</span>
          </label>
          <input
            id="task-wbs"
            className="form-input"
            type="text"
            value={wbs}
            onChange={(e) => setWbs(e.target.value)}
            placeholder="Ex: 1.2.3"
            disabled={saving}
          />
        </div>
      </div>

      {/* Tarefa-pai */}
      <div className="form-field">
        <label className="form-label" htmlFor="task-parent">
          Tarefa-pai
        </label>
        <select
          id="task-parent"
          className="form-input form-select"
          value={parentTaskId}
          onChange={(e) => setParentTaskId(e.target.value)}
          disabled={saving || !projectId}
        >
          <option value="">Nenhuma (tarefa raiz)</option>
          {parentOptions.map((t) => (
            <option key={t.id} value={t.id}>
              {t.wbs} — {t.name}
            </option>
          ))}
        </select>
      </div>

      {/* Datas (linha dupla) */}
      <div className="form-row">
        <div className="form-field form-field--grow">
          <label className="form-label" htmlFor="task-start">
            Início <span className="form-required">*</span>
          </label>
          <input
            id="task-start"
            className="form-input"
            type="date"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
            disabled={saving}
          />
        </div>

        <div className="form-field form-field--grow">
          <label className="form-label" htmlFor="task-end">
            Término <span className="form-required">*</span>
          </label>
          <input
            id="task-end"
            className="form-input"
            type="date"
            value={endDate}
            min={startDate}
            onChange={(e) => setEndDate(e.target.value)}
            disabled={saving}
          />
        </div>
      </div>

      {/* Progresso */}
      <div className="form-field">
        <label className="form-label" htmlFor="task-progress">
          Progresso: <strong>{progress}%</strong>
        </label>
        <input
          id="task-progress"
          className="form-range"
          type="range"
          min={0}
          max={100}
          step={5}
          value={progress}
          onChange={(e) => setProgress(Number(e.target.value))}
          disabled={saving}
        />
      </div>

      {/* Predecessoras FS */}
      {availableTasks.length > 0 && (
        <div className="form-field">
          <label className="form-label">Predecessoras (FS)</label>
          <div className="form-checklist">
            {availableTasks.map((t) => (
              <label key={t.id} className="form-check">
                <input
                  type="checkbox"
                  checked={predecessorIds.includes(t.id)}
                  onChange={() => togglePredecessor(t.id)}
                  disabled={saving}
                />
                <span>
                  {t.wbs} — {t.name}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Descrição */}
      <div className="form-field">
        <label className="form-label" htmlFor="task-description">
          Descrição
        </label>
        <textarea
          id="task-description"
          className="form-input form-textarea"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Descrição opcional"
          rows={2}
          disabled={saving}
        />
      </div>
    </FormModal>
  );
}
