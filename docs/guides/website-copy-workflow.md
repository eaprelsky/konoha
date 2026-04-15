# Website & Landing Page Copy — Skill-Based Workflow (#520)

## Rule

All website, landing page, and marketing copy tasks **must** use skills instead of ad-hoc prompting. This ensures consistent brand voice, structured output, and natural-sounding text.

## Mandatory skill sequence

When creating or editing website/landing page copy, agents **must** follow this pipeline:

### Step 1: Brand alignment (`brand-strategy`)

- Use the `brand-strategy` skill to check existing brand platform (mission, vision, values, archetype, voice)
- Ensure copy aligns with the established brand voice and tone
- If brand platform is not yet defined — this skill must be used first to establish it

### Step 2: Copy creation (`marketing`)

- Use the `marketing` skill to create the actual copy
- This skill handles positioning, messaging, channels, and content strategy
- Output goes to Yonote as the source of truth

### Step 3: Humanization (`humanizer`)

- Run the `humanizer` skill on all generated text before final delivery
- This removes AI-sounding patterns (cliché phrases, empty intensifiers, template structures)
- Ensures text reads naturally and sounds human-written

## When to apply

This workflow applies to:

| Task type | Examples |
|-----------|----------|
| Website pages | Homepage, About, Services, Contact, Case studies |
| Landing pages | Product launches, campaign pages, event pages |
| Marketing copy | Email campaigns, social media posts, ad copy |
| Product descriptions | Service descriptions, feature pages |
| CTAs and headers | Headlines, call-to-action buttons, taglines |

## Skill assignments

The following agents should have these skills assigned:

| Agent | `brand-strategy` | `marketing` | `humanizer` |
|-------|:-:|:-:|:-:|
| Naruto | yes | yes | yes |
| Kakashi | — | — | yes |
| Sasuke | — | — | yes |

## Routing

When a website/landing copy task arrives (from Yegor, trusted users, or GitHub issue):

1. **Naruto** receives the request
2. Naruto routes to the appropriate agent with explicit skill instructions:
   ```
   kakashi:fix issue=N — use /humanizer on all generated text
   ```
3. If the task requires creating new copy from scratch, Naruto routes to itself or an agent with `brand-strategy` + `marketing` skills

## Source of truth

All final copy artifacts live in **Yonote** (via MCP `yonote`), not in chat messages or local files.

## Checklist for copy tasks

- [ ] Brand voice checked via `brand-strategy`
- [ ] Copy created via `marketing` skill
- [ ] Text humanized via `humanizer`
- [ ] Final version saved to Yonote
- [ ] Stakeholder notified with link to Yonote doc
