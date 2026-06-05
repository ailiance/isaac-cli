// Side-effect imports: each module calls registerProvider() on load.
// Providers not listed here remain handled by the legacy switch in index.ts.

import "./openai-registry"
import "./openrouter-registry"
import "./lmstudio-registry"
import "./vscode-lm-registry"
import "./litellm-registry"
