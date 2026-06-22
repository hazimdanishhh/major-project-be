/**
 * src/services/llmService.js
 *
 * Wraps the Groq API call for AI-Augmented WBS Generation (Section 8.3).
 *
 * Flow:
 *   1. Build a structured prompt from the requirement + spec
 *   2. Call Groq (Llama 3.3 70B) with json_object response format
 *   3. Parse the returned JSON
 *   4. Run DFS sanitization to strip hallucinated cycles (sanitizeWBS)
 *   5. Return clean task list to the controller
 */

import { sanitizeWBS } from "../algorithms.js";

const GROQ_API_URL = "https://api.groq.com/openai/v1/chat/completions";
const GROQ_MODEL = "llama-3.3-70b-versatile";

const SYSTEM_PROMPT = `You are an expert technical project manager.
Given a project, its NEW client requirements, and a list of EXISTING project tasks, generate a consolidated Work Breakdown Structure (WBS) for the NEW requirements.
Do NOT duplicate existing tasks. 

Return ONLY a valid JSON object with this exact structure:
{
  "tasks": [
    {
      "temp_id": "t1",
      "requirement_id": "uuid-of-the-primary-requirement",
      "title": "Short action-oriented task title",
      "description": "Clear implementation detail",
      "estimated_hours": 4,
      "priority": "HIGH",
      "depends_on_temp_ids": [],
      "depends_on_existing_task_ids": []
    }
  ]
}

Rules:
- requirement_id MUST be the exact UUID of the requirement.
- temp_id must be unique strings like "t1", "t2".
- depends_on_temp_ids lists temp_ids of NEW tasks that must be completed first.
- depends_on_existing_task_ids lists the real UUIDs of EXISTING tasks that must be completed first.
- ONLY create dependencies if a task strictly requires the output of another. Maximize parallel work.
- Do NOT create circular dependencies.`;

/**
 * @param {object} project
 * @param {Array<object>} requirements
 * @param {Array<object>} specs
 * @param {Array<object>} existingTasks
 */
export default async function generateWBS(
  project,
  requirements,
  specs,
  existingTasks = [],
) {
  if (!process.env.GROQ_API_KEY)
    throw new Error("LLM: GROQ_API_KEY is not configured.");

  const projectContext = requirements
    .map((req) => {
      const reqSpecs = specs.filter((s) => s.requirement_id === req.id);
      return `
=== Requirement ID: ${req.id} ===
Title: ${req.title}
Description: ${req.description || "None"}
Specifications:
${reqSpecs.map((s, i) => `  - Spec ${i + 1}: ${s.title} -> ${s.description}`).join("\n")}
`;
    })
    .join("\n");

  const existingContext = existingTasks.length
    ? `\n=== EXISTING TASKS IN SYSTEM ===\n(Do not recreate these. Use their UUIDs in depends_on_existing_task_ids if a new task depends on them)\n` +
      existingTasks
        .map((t) => `- [${t.id}] ${t.title} (Status: ${t.status})`)
        .join("\n")
    : "\n=== EXISTING TASKS IN SYSTEM ===\nNone.";

  const userPrompt = `Project: ${project.name}
Description: ${project.description || "None"}

Generate incremental WBS tasks for the following approved requirements:
${projectContext}
${existingContext}`;

  let response;
  try {
    response = await fetch(GROQ_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        temperature: 0.3, // low temperature for more deterministic JSON output
        max_tokens: 2048,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
      }),
    });
  } catch (networkErr) {
    throw new Error(
      `LLM: Network error calling Groq API — ${networkErr.message}`,
    );
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`LLM: Groq API returned ${response.status} — ${body}`);
  }

  const data = await response.json();

  let raw;
  try {
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("Empty content from LLM");
    raw = JSON.parse(content);
  } catch (parseErr) {
    throw new Error(
      `LLM: Failed to parse JSON from Groq response — ${parseErr.message}`,
    );
  }

  if (!Array.isArray(raw.tasks)) {
    throw new Error('LLM: Response did not contain a "tasks" array.');
  }

  // DFS-based cycle sanitization — strips hallucinated circular deps
  return sanitizeWBS(raw.tasks);
}
