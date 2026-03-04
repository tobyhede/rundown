# PR #{{pr_number}} Feedback Summary

**Generated:** {{date}}
**PR Title:** {{pr_title}}
**PR URL:** {{pr_url}}
**Review Status:** {{review_decision}}

---

## Summary

| Severity | Total | Valid | Fixed | Invalid | Needs Discussion |
|----------|-------|-------|-------|---------|------------------|
| Critical | {{critical_total}} | {{critical_valid}} | {{critical_fixed}} | {{critical_invalid}} | {{critical_discuss}} |
| Major | {{major_total}} | {{major_valid}} | {{major_fixed}} | {{major_invalid}} | {{major_discuss}} |
| Minor | {{minor_total}} | {{minor_valid}} | {{minor_fixed}} | {{minor_invalid}} | {{minor_discuss}} |
| Nitpick | {{nitpick_total}} | {{nitpick_valid}} | {{nitpick_fixed}} | {{nitpick_invalid}} | {{nitpick_discuss}} |

**Progress:** {{completed_count}}/{{total_valid}} items addressed

---

## Critical Issues

These must be fixed before merge.

{{#if critical_items}}
{{#each critical_items}}
### `{{file}}:{{line}}`

**Issue:** {{description}}

{{#if suggestion}}
**Suggested Fix:** {{suggestion}}
{{/if}}

**Reviewer:** {{reviewer}}
**Validation:** {{status}}{{#if status_reason}} - {{status_reason}}{{/if}}

- [ ] TODO

---

{{/each}}
{{else}}
No critical issues found.
{{/if}}

## Major Issues

These should be fixed before merge.

{{#if major_items}}
{{#each major_items}}
### `{{file}}:{{line}}`

**Issue:** {{description}}

{{#if suggestion}}
**Suggested Fix:** {{suggestion}}
{{/if}}

**Reviewer:** {{reviewer}}
**Validation:** {{status}}{{#if status_reason}} - {{status_reason}}{{/if}}

- [ ] TODO

---

{{/each}}
{{else}}
No major issues found.
{{/if}}

## Minor Issues

Nice to fix, but not blocking.

{{#if minor_items}}
{{#each minor_items}}
- [ ] `{{file}}:{{line}}` - {{description}} ({{status}})
{{/each}}
{{else}}
No minor issues found.
{{/if}}

## Nitpicks

Optional improvements and suggestions.

{{#if nitpick_items}}
{{#each nitpick_items}}
- [ ] `{{file}}:{{line}}` - {{description}} ({{status}})
{{/each}}
{{else}}
No nitpicks found.
{{/if}}

## Skipped Items

Items that were skipped during validation.

{{#if skipped_items}}
| File | Line | Reason | Original Issue |
|------|------|--------|----------------|
{{#each skipped_items}}
| `{{file}}` | {{line}} | {{skip_reason}} | {{description}} |
{{/each}}
{{else}}
No items were skipped.
{{/if}}

---

## Next Steps

1. Address all **Critical** issues before requesting re-review
2. Address all **Major** issues before merge
3. Consider **Minor** issues based on time/priority
4. Review **Nitpicks** for future improvements
5. Discuss items marked **NEEDS_DISCUSSION** with reviewers

## Notes

{{notes}}
