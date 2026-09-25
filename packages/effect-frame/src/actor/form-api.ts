/**
 * `Form` as an app reads it: the codec and its types, the checkbox, the
 * field-map helpers, and a refused post's issues. The plumbing the view and
 * the post route share (framework field names, `decode`, the structural
 * schemas) stays in `form.ts`, which the framework imports by path.
 */
export {
  Checkbox,
  FormContext,
  codec,
  decodeIssues,
  decodeKey,
  encodeIssues,
  encodeKey,
  freshCommandId,
  fromBody,
  fromEntries,
  isReturnPath,
  issuesOf,
  issuesScriptId,
  last,
  maxDepth,
  maxFields,
  provideIssues,
  strip,
  submitted,
  toBody,
  toEntries,
  tree,
  type Codable,
  type Covered,
  type FormFields,
  type FormIssue,
  type FormIssues,
  type FormOutcome,
  type FormTree,
  type Refusal,
  type Uncovered,
} from "./form.js";
