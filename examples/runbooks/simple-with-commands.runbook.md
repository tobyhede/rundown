# Simple Runbook with Commands

Simple sequential build & deploy workflow

## 1. Install project dependencies

```bash
tsv echo npm install
```

## 2. Run lint

```bash
tsv echo npm run lint
```

- PASS: CONTINUE
- FAIL: STOP

## 3. Run tests

```bash
tsv echo npm test
```

- PASS: CONTINUE
- FAIL: STOP "Failed to run tests"

## 4. Build

```bash
tsv echo --result fail --result pass npm run build
```

- PASS: CONTINUE
- FAIL: RETRY

## 5. Deploy

```bash
tsv echo --result fail --result fail --result pass npm run deploy
```

- PASS: COMPLETE
- FAIL: RETRY 3