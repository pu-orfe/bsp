# CSV Templates

Starting points for `examples/import-csv.js`. Each pairs with a mapping in
`examples/mappings/`, which is what actually decides how a column becomes a
Drupal field - edit the mapping rather than the script.

| Template | Mapping | Notes |
|----------|---------|-------|
| `events-roster.csv` | `../mappings/ps-events-symposium.json` | Speaker roster for a `ps_events` conference day. Blank `Talk Title` / `Adviser` become `TBD`. |
| `articles.csv` | `../mappings/article-basic.json` | Two-column example against Drupal core's `article` type. |

## Partially complete rosters

`Event Audience`, `Date`, `Start Time` and `End Time` may be left blank and
filled in later by `examples/schedule-events.js`, which assigns rooms and time
slots reproducibly from a seed:

```bash
node examples/schedule-events.js --csv roster.csv \
  --rooms '001 - Sherrerd Hall,003 - Sherrerd Hall' \
  --date 2027-04-30 --seed 20270430 \
  --start '9:00 AM' --slot 15 --break '10:15 AM' --break-minutes 30
```

## Column names are not fixed

Nothing in the tooling requires these headers. A CSV of `Name,Room,When` works
just as well with a mapping that reads those columns:

```json
{
  "contentType": "ps_events",
  "fields": {
    "title": { "template": "{Name}", "required": true },
    "event_audience": "{Room}",
    "event_start_date": { "template": "{When}", "transform": "date" }
  }
}
```

## Round-tripping

`examples/export-csv.js` writes the same shape, so content can be exported,
edited in a spreadsheet, and imported back:

```bash
node examples/export-csv.js --type Event --out roster.csv \
  --columns id,title,status \
  --field 'field_ps_events_subtitle[0][value]=Talk Title'
```
