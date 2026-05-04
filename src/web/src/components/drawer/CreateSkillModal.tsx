import { useState, KeyboardEvent } from "react";
import { X } from "lucide-react";

interface CreateSkillModalProps {
  onClose: () => void;
  onCreated: (name: string) => void;
}

function ChipInput({
  values,
  onChange,
  placeholder,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder?: string;
}) {
  const [input, setInput] = useState("");

  function commit() {
    const trimmed = input.trim();
    if (trimmed && !values.includes(trimmed)) {
      onChange([...values, trimmed]);
    }
    setInput("");
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      commit();
    }
    if (e.key === "Backspace" && !input && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  }

  return (
    <div className="flex flex-wrap gap-1.5 items-center min-h-[38px] rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 focus-within:border-zinc-500 transition-colors cursor-text"
      onClick={(e) => {
        const input = (e.currentTarget as HTMLElement).querySelector("input");
        input?.focus();
      }}
    >
      {values.map((v) => (
        <span
          key={v}
          className="flex items-center gap-1 text-xs bg-zinc-700 text-zinc-200 rounded-md px-2 py-0.5 select-none"
        >
          {v}
          <button
            type="button"
            tabIndex={-1}
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="text-zinc-400 hover:text-zinc-100 leading-none transition-colors"
          >
            ×
          </button>
        </span>
      ))}
      <input
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={commit}
        placeholder={values.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[160px] bg-transparent text-sm text-zinc-200 placeholder:text-zinc-600 outline-none"
      />
    </div>
  );
}

export function CreateSkillModal({ onClose, onCreated }: CreateSkillModalProps) {
  const [scope, setScope] = useState<"project" | "user">("project");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [triggerPhrases, setTriggerPhrases] = useState<string[]>([]);
  const [antiTriggerPhrases, setAntiTriggerPhrases] = useState<string[]>([]);
  const [body, setBody] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && description.trim().length > 0 && !submitting;

  async function handleCreate() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("Skill name is required.");
      return;
    }
    if (!description.trim()) {
      setError("Description is required — it tells the model when to use this skill.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/skills/library/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope,
          name: trimmedName,
          description: description.trim(),
          tags,
          triggerPhrases,
          antiTriggerPhrases,
          body: body.trim() || undefined,
        }),
      });
      const data = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to create skill");
      onCreated(trimmedName);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50 p-4">
      <div className="bg-zinc-900 border border-zinc-700 rounded-xl w-full max-w-2xl shadow-2xl max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-zinc-100">New Skill</h3>
          <button
            onClick={onClose}
            className="rounded-md p-1 text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800/60 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Body */}
        <div className="p-5 space-y-4 overflow-y-auto">
          {/* Name + Scope */}
          <div className="grid grid-cols-3 gap-3">
            <div className="col-span-2 space-y-1.5">
              <label className="text-xs text-zinc-500 uppercase tracking-wide">Name *</label>
              <input
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void handleCreate();
                  if (e.key === "Escape" && !submitting) onClose();
                }}
                placeholder="e.g. api-contract-qa"
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 font-mono transition-colors"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-zinc-500 uppercase tracking-wide">Scope</label>
              <select
                value={scope}
                onChange={(e) => setScope(e.target.value as "project" | "user")}
                className="select-flat w-full px-3 py-2 text-sm"
              >
                <option value="project">Project</option>
                <option value="user">User</option>
              </select>
            </div>
          </div>

          {/* Description */}
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500 uppercase tracking-wide">Description *</label>
            <p className="text-[11px] text-zinc-600">
              Shown to the model to decide whether to activate this skill. Be precise.
            </p>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="When reviewing API changes, verify that endpoint contracts match implementation and catch breaking changes before they ship."
              rows={2}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 resize-none transition-colors"
            />
          </div>

          {/* Tags */}
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500 uppercase tracking-wide">Tags</label>
            <p className="text-[11px] text-zinc-600">
              Categorize this skill. Press Enter or comma to add each tag.
            </p>
            <ChipInput
              values={tags}
              onChange={setTags}
              placeholder="api, contracts, review…"
            />
          </div>

          {/* Trigger phrases */}
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500 uppercase tracking-wide">Trigger phrases</label>
            <p className="text-[11px] text-zinc-600">
              Phrases in a task or message that should activate this skill.
            </p>
            <ChipInput
              values={triggerPhrases}
              onChange={setTriggerPhrases}
              placeholder="review API contract, check endpoint schema, API drift…"
            />
          </div>

          {/* Anti-trigger phrases */}
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500 uppercase tracking-wide">
              Anti-trigger phrases
            </label>
            <p className="text-[11px] text-zinc-600">
              Phrases that look similar but should NOT activate this skill.
            </p>
            <ChipInput
              values={antiTriggerPhrases}
              onChange={setAntiTriggerPhrases}
              placeholder="review UI design, check CSS…"
            />
          </div>

          {/* Body */}
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500 uppercase tracking-wide">
              Instructions (Markdown)
            </label>
            <p className="text-[11px] text-zinc-600">
              Step-by-step instructions for how to execute this skill. Leave blank for a starter
              template.
            </p>
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder={`# api-contract-qa\n\nPurpose:\n- Verify API contracts match implementation.\n\nHow to execute:\n1. Read the OpenAPI spec or route definitions.\n2. Compare against actual handler code.\n3. Flag any mismatches or missing fields.`}
              rows={9}
              className="w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-zinc-500 resize-none font-mono transition-colors"
            />
          </div>

          {error && <p className="text-xs text-bender-danger">{error}</p>}
          <p className="text-xs text-zinc-600">⌘ Enter to create</p>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-zinc-800 flex justify-end gap-2">
          <button
            onClick={onClose}
            disabled={submitting}
            className="px-3 py-1.5 text-xs rounded-md text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/60 transition-colors disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => void handleCreate()}
            disabled={!canSubmit}
            className="px-4 py-1.5 text-xs font-medium bg-zinc-100 text-zinc-900 rounded-md hover:bg-white disabled:opacity-40 transition-colors"
          >
            {submitting ? "Creating…" : "Create Skill"}
          </button>
        </div>
      </div>
    </div>
  );
}
