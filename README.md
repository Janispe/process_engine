# Process Engine

Generic process workflow engine for Frappe (DocTypes, DAG, task handlers,
optional Temporal backend).

Apps register their process definitions via hook:

```python
# in consumer_app/hooks.py
process_engine_runtimes = [
    "consumer_app.process_definitions.my_process.get_my_process_runtime",
]
```

## License

MIT
