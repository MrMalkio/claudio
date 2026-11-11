# Claudio — agent rules

## Branches (no GitHub Actions or branch protection; this file is the rule)

- `main` is production. Only Malkio merges into `main`.
- `staging` is where work collects before production.
- Every change starts on its own branch, cut from `staging`.
- Agents open a PR from their branch to `staging` and may merge it themselves
  once it's tested.
- Agents then open (or update) one PR from `staging` to `main` for Malkio to
  merge.
- No co-author or AI attribution lines in commits or PRs.
