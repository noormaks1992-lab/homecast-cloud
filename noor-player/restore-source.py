import json
from pathlib import Path
root = Path(__file__).resolve().parent
files = json.loads((root / 'source.snapshot.json').read_text(encoding='utf-8'))['files']
output = root / 'source'
for name, text in files.items():
    target = output / name
    if '..' in Path(name).parts or Path(name).is_absolute():
        raise ValueError('Unsafe path')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding='utf-8')
print('Restored application source into', output)
