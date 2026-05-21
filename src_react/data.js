// Static constants used by the editor. No SEED data in production —
// the editor receives schritte/schritt_io/payload_field_specs as props.

// Task-type metadata — visual identity per Prozess Schritt.task_type.
export const TASK_TYPES = {
  manual_check:     { label: "Manual Check",       hue: 0,   chroma: 0,    glyph: "✓" },
  file_upload:      { label: "File Upload",        hue: 240, chroma: 0.13, glyph: "⇧" },
  python_action:    { label: "Python Action",      hue: 285, chroma: 0.13, glyph: "λ" },
  print_document:   { label: "Print Document",     hue: 35,  chroma: 0.13, glyph: "⎙" },
  paperless_export: { label: "Paperless Export",   hue: 180, chroma: 0.13, glyph: "→" },
  email_draft:      { label: "Email Draft",        hue: 220, chroma: 0.13, glyph: "✉" },
  create_linked_doc:{ label: "Create Linked Doc",  hue: 335, chroma: 0.13, glyph: "+" },
};

export const TASK_TYPE_KEYS = Object.keys(TASK_TYPES);

// Field types supported in Prozess Field Spec.
export const FIELD_TYPES = [
  "Data", "Link", "Date", "Datetime", "Int", "Float",
  "Currency", "Check", "Select", "Small Text", "Long Text",
];
