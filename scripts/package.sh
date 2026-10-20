#!/bin/sh
# Собирает dist/yandex-disk-download-all.zip для страницы релиза на GitHub.
# Файлы расширения лежат прямо в корне архива: «Извлечь все…» в Windows и «Архиватор» macOS
# сами кладут их в папку yandex-disk-download-all, без папки в папке. Имя архива не зависит
# от версии: ссылка releases/latest/download/yandex-disk-download-all.zip всегда ведёт на свежую,
# а новая версия распаковывается поверх старой папки.
set -eu
cd "$(dirname "$0")/.."
name="yandex-disk-download-all"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir -p dist "$tmp/$name"
cp -R extension/. "$tmp/$name/"
cp README.md LICENSE "$tmp/$name/"
# Инструкции на всех языках: README ссылается на них, а без интернета они тоже пригодятся.
cp -R guide "$tmp/$name/"
# Из docs/ — только картинки, которые показывает README (сайт в пакет расширения не нужен).
mkdir -p "$tmp/$name/docs"
for img in $(grep -o 'docs/[A-Za-z0-9_-]*\.png' README.md | sort -u); do cp "$img" "$tmp/$name/$img"; done
find "$tmp" -name '.DS_Store' -delete
rm -f "dist/$name.zip"
(cd "$tmp/$name" && zip -qr -X "$OLDPWD/dist/$name.zip" .)
echo "dist/$name.zip ($(node -p "require('./extension/manifest.json').version"))"
