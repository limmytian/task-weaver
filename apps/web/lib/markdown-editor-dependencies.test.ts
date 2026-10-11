import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { markdown } from "@codemirror/lang-markdown";
import { EditorView } from "@codemirror/view";
import { autocompletion } from "@codemirror/autocomplete";

const require = createRequire(import.meta.url);
const editorRequire = createRequire(require.resolve("@uiw/react-codemirror"));

test("React CodeMirror accepts the Markdown editor extension graph", () => {
  const { EditorState } = editorRequire("@codemirror/state");
  const state = EditorState.create({
    doc: "# Document fixture",
    extensions: [
      markdown(),
      EditorView.lineWrapping,
      autocompletion({ override: [] }),
      EditorView.theme({ "&": { minHeight: "200px" } }),
    ],
  });
  assert.equal(state.doc.toString(), "# Document fixture");
});
