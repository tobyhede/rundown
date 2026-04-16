# Invalid: OUTPUTS After Body Content

## 1. Step with late OUTPUTS

```bash
echo "This is body content"
```

- OUTPUTS
  - Foo {{ "bar" }}
