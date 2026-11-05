/**
 * "New project" templates (decision 57). Each is plain GitHub Markdown, so a
 * project made from one reads the same on GitHub as in docwalk (rule 1).
 * The project name goes in as text only; it is never parsed as Markdown
 * syntax beyond being a heading.
 */

export interface ProjectTemplate {
  id: "blank" | "design" | "talk";
  label: string;
  description: string;
  /** The file opened after the project is created. */
  main: string;
  files: (title: string) => { path: string; text: string }[];
}

/** Keeps a user-typed title from starting Markdown syntax of its own on the heading line. */
function heading(title: string): string {
  return title.replace(/[\r\n]+/g, " ").replace(/^[#>\-+*\d.\s]+/, "") || "Untitled";
}

/** A new, nearly empty document: a title and one line on how slides are made. */
export function starter(title: string): string {
  return `# ${heading(title)}\n\nWrite here. Each \`##\` heading starts a new slide.\n`;
}

export const TEMPLATES: readonly ProjectTemplate[] = [
  {
    id: "blank",
    label: "Blank",
    description: "One empty README.md.",
    main: "README.md",
    files: (title) => [{ path: "README.md", text: starter(title) }],
  },
  {
    id: "design",
    label: "Design doc",
    description: "Context, goals, a proposal with a diagram, alternatives and rollout.",
    main: "README.md",
    files: (title) => [
      {
        path: "README.md",
        text: `# ${heading(title)}

## Context

What exists today and why it is not enough.

## Goals

- The outcome this design must reach.
- How we will know it worked.

## Non-goals

- What this design deliberately leaves out.

## Proposal

How it works, in a few paragraphs.

\`\`\`mermaid
flowchart LR
  Client --> Service
  Service --> Store[(Storage)]
\`\`\`

## Alternatives considered

| Option | Why not |
| ------ | ------- |
| A      | Reason  |
| B      | Reason  |

## Rollout

1. Build behind a flag.
2. Turn it on for one team.
3. Turn it on for everyone.

## Open questions

- What is still undecided.
`,
      },
    ],
  },
  {
    id: "talk",
    label: "Talk",
    description: "Short slides: agenda, problem, idea, a sequence diagram, next steps.",
    main: "talk.md",
    files: (title) => [
      {
        path: "talk.md",
        text: `# ${heading(title)}

## Agenda

1. The problem
2. The idea
3. How it works
4. Next steps

## The problem

One sentence the room should remember.

## The idea

- A short point.
- Another short point.

## How it works

\`\`\`mermaid
sequenceDiagram
  participant User
  participant App
  User->>App: Request
  App-->>User: Response
\`\`\`

## Next steps

- Who does what, by when.

## Questions
`,
      },
    ],
  },
];
