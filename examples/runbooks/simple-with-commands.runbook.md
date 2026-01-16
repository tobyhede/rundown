# Simple Runbook with Commands

Simple sequential build & deploy runbook

## 1. Install project dependencies

```bash
tsv echo npm install
```

## 2. Run lint

- PASS: CONTINUE
- FAIL: STOP

```bash
tsv echo npm run lint
```

## 3. Run tests

- PASS: CONTINUE
- FAIL: STOP "Failed to run tests"

```bash
tsv echo npm test
```

## 4. Build

- PASS: CONTINUE
- FAIL: RETRY

```bash
tsv echo --result fail --result pass npm run build
```

## 5. Deploy

- PASS: COMPLETE
- FAIL: RETRY 3

```bash
tsv echo --result fail --result fail --result pass npm run deploy
```