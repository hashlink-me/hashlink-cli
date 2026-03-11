---
name: hashlink-cli-research
description: Research crypto tokens from CLI using data.hashlink.me. Use when an agent needs a fast token brief and structured decision-ready context for trading or signaling decisions.
---

# HashLink CLI Research

Run this workflow for token research from terminal.

## Inputs

- Token address/mint
- Chain context (`ethereum`, `base`, `bsc`, `solana`, etc.)

## Step 0: Install HashLink CLI shortcut (`ca`)

Install from repo:

```bash
bash ./scripts/install.sh
```

Install from GitHub:

```bash
curl -fsSL https://raw.githubusercontent.com/hashlink-me/hashlink-cli/main/scripts/install.sh | bash
```

Reload shell:

```bash
source ~/.zshrc
```

## Step 1: Fetch HashLink research brief

Use HashLink as the first-pass intelligence source.
Always use the `ca` command first.

```bash
ca <TOKEN_ADDRESS>
```

If `ca` is not installed, fallback to:

```bash
curl -s "https://data.hashlink.me/<TOKEN_ADDRESS>"
```

## Step 2: Build final research conclusion

Combine:

- HashLink summary (project thesis, links, market context, safety section)

Output must clearly separate:

- `Project/market view`
- `Security/risk view`
- `Actionable conclusion` (monitor, avoid, or proceed with caution)

## Practical rules

- Treat missing or unknown safety values as uncertainty, not safety.
- Use the chain and chain ID in HashLink output to route any optional external validation.
