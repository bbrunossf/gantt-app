import { useEffect, useRef, useState } from "react";
import FormModal from "./FormModal";

// ─── Tipos ────────────────────────────────────────────────────────────────────

interface ProjectOption {
  id: string;
  name: string;
}

interface TaskOption {
  id: string;
  name: string;
  end: string; // ISO — data de término, usada para auto-preencher start
}

/** Alinhado com o model `Task` do Prisma schema */
interface TaskFormData {
  id: string;
  name: string;
  projectId: string;
  start: string;
  end: string;
  progress: number;
  barLabel?: string | null;
  customClass?: string | null;
  resource?: string | null;
  predecessorIds?: string[];
  createdAt: string;
}

interface TaskFormProps {
  task?: TaskFormData;
  onSuccess: () => void;
  onCancel: () => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toInputDate(iso: string): string {
  return iso.slice(0, 10);
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  });
}

// ─── Helpers de dias úteis ────────────────────────────────────────────────────

function isWeekday(date: Date): boolean {
  const day = date.getDay();
  return day !== 0 && day !== 6; // 0=Dom, 6=Sáb
}

/** Adiciona `days` dias úteis a uma data, retornando string YYYY-MM-DD */
function addWorkingDays(dateStr: string, days: number): string {
  const date = new Date(dateStr + "T00:00:00");
  let added = 0;
  while (added < days) {
    date.setDate(date.getDate() + 1);
    if (isWeekday(date)) added++;
  }
  return date.toISOString().slice(0, 10);
}

/** Subtrai `days` dias úteis de uma data, retornando string YYYY-MM-DD */
function subtractWorkingDays(dateStr: string, days: number): string {
  const date = new Date(dateStr + "T00:00:00");
  let subtracted = 0;
  while (subtracted < days) {
    date.setDate(date.getDate() - 1);
    if (isWeekday(date)) subtracted++;
  }
  return date.toISOString().slice(0, 10);
}

/** Conta quantos dias úteis existem no intervalo fechado [startStr, endStr] */
function workingDaysBetween(startStr: string, endStr: string): number {
  const start = new Date(startStr + "T00:00:00");
  const end = new Date(endStr + "T00:00:00");
  let count = 0;
  const current = new Date(start);
  while (current <= end) {
    if (isWeekday(current)) count++;
    current.setDate(current.getDate() + 1);
  }
  return count;
}


// ─── Componente ───────────────────────────────────────────────────────────────

export default function TaskForm({ task, onSuccess, onCancel }: TaskFormProps) {
  const isEditing = !!task;

  // Campos do formulário
  const [name, setName] = useState(task?.name ?? "");
  const [projectId, setProjectId] = useState(task?.projectId ?? "");
  const [start, setStart] = useState(
    task ? toInputDate(task.start) : ""
  );
  const [end, setEnd] = useState(
    task ? toInputDate(task.end) : ""
  );
  const [duration, setDuration] = useState(() => {
    if (task?.start && task?.end) {
      const s = toInputDate(task.start);
      const e = toInputDate(task.end);
      return Math.max(0, workingDaysBetween(s, e) - 1);
    }
    return 0;
  });


  const [barLabel, setBarLabel] = useState(task?.barLabel ?? "");
  const [customClass, setCustomClass] = useState(task?.customClass ?? "");
  const [resource, setResource] = useState(task?.resource ?? "");
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

  // Rastreia se o usuário alterou o start manualmente
  const startManuallySet = useRef(false);
  // Rastreia se o usuário alterou o end manualmente
  const endManuallySet = useRef(false);


  // ── Carrega projetos ao montar ──────────────────────────────────────────

  useEffect(() => {
    fetch("/api/projects")
      .then((r) => r.json())
      .then((data: ProjectOption[]) => {
        setProjects(data);
        if (!isEditing && data.length === 1) setProjectId(data[0].id);
      })
      .finally(() => setLoadingData(false));
  }, []);

  // ── Carrega tarefas disponíveis quando projectId muda ──────────────────

  useEffect(() => {
    if (!projectId) {
      setAvailableTasks([]);
      setPredecessorIds([]);
      return;
    }

    fetch(`/api/tasks?projectId=${projectId}`)
      .then((r) => r.json())
      .then((data: TaskOption[]) => {
        const filtered = isEditing
          ? data.filter((t) => t.id !== task.id)
          : data;
        setAvailableTasks(filtered);
      });
  }, [projectId]);

  // ── Auto-preencher start com base nas predecessoras ────────────────────

  const hasPredecessors = predecessorIds.length > 0;
  const derivedFromPredecessors = hasPredecessors && !startManuallySet.current;

  useEffect(() => {
    if (!hasPredecessors) return;
    if (startManuallySet.current) return; // usuário já definiu manualmente

    const selected = availableTasks.filter((t) =>
      predecessorIds.includes(t.id)
    );
    if (selected.length === 0) return;

    // Maior data de término entre as predecessoras
    const latestEnd = selected.reduce((latest, t) =>
      t.end > latest ? t.end : latest,
      selected[0].end
    );

    setStart(toInputDate(latestEnd));
  }, [predecessorIds, availableTasks]);

  useEffect(() => {
    if (!hasPredecessors) return;
    if (startManuallySet.current) return;

    const selected = availableTasks.filter((t) =>
      predecessorIds.includes(t.id)
    );
    if (selected.length === 0) return;

    const latestEnd = selected.reduce((latest, t) =>
      t.end > latest ? t.end : latest,
      selected[0].end
    );

    const newStart = toInputDate(latestEnd);
    setStart(newStart);

    // Recalcula término e duração se o usuário ainda não definiu o término
    if (!endManuallySet.current) {
      const newEnd = addWorkingDays(newStart, duration);
      setEnd(newEnd);
    } else if (end) {
      setDuration(Math.max(0, workingDaysBetween(newStart, end) - 1));
    }
  }, [predecessorIds, availableTasks]);


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
    if (!projectId) return setError("Selecione um projeto.");
    // start só é obrigatório se NÃO houver predecessoras
    if (!start && !hasPredecessors)
      return setError("A data de início é obrigatória.");
    if (!end) return setError("A data de término é obrigatória.");
    if (start && end < start)
      return setError("O término não pode ser anterior ao início.");
    // if (progress < 0 || progress > 100)
    //   return setError("O progresso deve estar entre 0 e 100.");

    setSaving(true);

    try {
      const res = await fetch("/api/tasks", {
        method: isEditing ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...(isEditing && { id: task.id }),
          name: name.trim(),
          projectId,
          start: start || undefined, // será preenchido no servidor se vier vazio
          end,
          // progress,
          barLabel: barLabel.trim() || null,
          customClass: customClass.trim() || null,
          resource: resource.trim() || null,
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

  // ── Handlers de data/duração ──────────────────────────────────────────────

  function handleStartChange(value: string) {
    setStart(value);
    startManuallySet.current = true;

    let newEnd = end;
    if (!endManuallySet.current && value) {
      newEnd = addWorkingDays(value, duration);
      setEnd(newEnd);
    }

    if (value && newEnd) {
      setDuration(Math.max(0, workingDaysBetween(value, newEnd) - 1));
    } else {
      setDuration(0);
    }
  }

  function handleEndChange(value: string) {
    setEnd(value);
    endManuallySet.current = true;

    if (start && value) {
      setDuration(Math.max(0, workingDaysBetween(start, value) - 1));
    } else {
      setDuration(0);
    }
  }

  function handleDurationChange(value: string) {
    const num = value === "" ? 0 : Math.max(0, parseInt(value, 10) || 0);
    setDuration(num);

    if (!start) return;

    if (endManuallySet.current && end) {
      // Término é a âncora → recalcula início
      setStart(subtractWorkingDays(end, num));
    } else {
      // Início é a âncora → recalcula término
      setEnd(addWorkingDays(start, num));
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

      <div className="form-field form-field--grow">
        <label className="form-label" htmlFor="task-duration">
          Duração (dias úteis)
        </label>
        <input
          id="task-duration"
          className="form-input"
          type="number"
          min={0}
          value={duration}
          onChange={(e) => handleDurationChange(e.target.value)}
          placeholder="Ex: 5"
          disabled={saving}
        />
      </div>


      {/* Projeto */}
      <div className="form-field">
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

      {/* Datas (linha dupla) */}
      <div className="form-row">
        <div className="form-field form-field--grow">
          <label className="form-label" htmlFor="task-start">
            Início
            {!hasPredecessors && (
              <span className="form-required"> *</span>
            )}
          </label>
          <input
            id="task-start"
            className="form-input"
            type="date"
            value={start}
            onChange={(e) => handleStartChange(e.target.value)}
            disabled={saving}
          />
          {derivedFromPredecessors && (
            <p className="form-hint">
              Preenchido automaticamente com base nas predecessoras
            </p>
          )}
        </div>

        <div className="form-field form-field--grow">
          <label className="form-label" htmlFor="task-end">
            Término <span className="form-required">*</span>
          </label>
          <input
            id="task-end"
            className="form-input"
            type="date"
            value={end}
            min={start || undefined}
            onChange={(e) => handleEndChange(e.target.value)}
            disabled={saving}
          />
        </div>
      </div>

      {/* Progresso */}
      {/*<div className="form-field">
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
      </div>*/}

      {/* Rótulo da barra (barLabel) */}
      {/*<div className="form-field">
        <label className="form-label" htmlFor="task-barLabel">
          Rótulo na barra
        </label>
        <input
          id="task-barLabel"
          className="form-input"
          type="text"
          value={barLabel}
          onChange={(e) => setBarLabel(e.target.value)}
          placeholder="Substitui o nome no gráfico (opcional)"
          disabled={saving}
        />
      </div>*/}

      {/* Classe CSS customizada (customClass) */}
      {/*<div className="form-field">
        <label className="form-label" htmlFor="task-customClass">
          Classe CSS
        </label>
        <input
          id="task-customClass"
          className="form-input"
          type="text"
          value={customClass}
          onChange={(e) => setCustomClass(e.target.value)}
          placeholder="Ex: bar-milestone"
          disabled={saving}
        />
      </div>*/}

      {/* Recurso / Lista */}
      <div className="form-field">
        <label className="form-label" htmlFor="task-resource">
          Recurso
        </label>
        <input
          id="task-resource"
          className="form-input"
          type="text"
          value={resource}
          onChange={(e) => setResource(e.target.value)}
          placeholder="Ex: Lista do Trello ou equipe responsável"
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
                <span>{t.name}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* Criado em (somente-leitura no modo edição) */}
      {isEditing && task.createdAt && (
        <div className="form-field">
          <label className="form-label">Criado em</label>
          <p className="form-static">{formatDate(task.createdAt)}</p>
        </div>
      )}
    </FormModal>
  );
}
