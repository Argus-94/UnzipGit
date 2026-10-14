# UnzipGit

Android-приложение для работы с GitHub: распаковка ZIP в репозиторий, файловый менеджер, релизы, Actions и токены. Интерфейс на русском.

## Возможности

- **Распаковка ZIP** в репозиторий (локальный файл или архив уже в repo)
- **Репозитории** — список, поиск, создание и удаление
- **Файлы** — две панели, редактор с подсветкой, автокоммиты, скачивание, дублирование, свойства
- **Релизы** — создание, загрузка ассетов, управление
- **GitHub Actions** — workflow, запуски, jobs, логи, артефакты, правка YAML, запрос прав токена
- **Токены и ключи** — PAT на устройстве, проверка прав Actions, SSH-ключи, генератор API-ключей

## Стек

| | |
|---|---|
| Gradle | 8.5 |
| AGP | 8.2.2 |
| Kotlin | 1.9.24 |
| compileSdk / targetSdk | 34 |
| minSdk | 24 |
| Java | 17 |

## Сборка

1. Откройте проект в Android Studio  
2. Дождитесь синхронизации Gradle  
3. **Build → Build APK(s)**

Release-подпись: положите `key.properties` (не в git) и настройте `signingConfigs` в `app/build.gradle` при необходимости.

## Использование

1. Добавьте GitHub-токен на экране «Токены» (fine-grained: Contents + Actions; для admin — Administration)  
2. Выберите репозиторий  
3. Работайте через меню: Файлы, Релизы, Actions, Распаковка ZIP  

Токен хранится только на устройстве. Не коммитьте его в репозиторий.

## Структура

```
app/src/main/
  java/.../MainActivity.kt   — WebView + native bridge (download/upload/http)
  assets/                    — HTML/JS/CSS экраны
  res/                       — меню, строки, иконки
.github/workflows/android.yml — CI: JS syntax + assembleDebug
```

## Ограничения

Не полный клиент GitHub: нет Issues/PR/Projects. Подробные логи CI удобнее смотреть на github.com; в приложении доступны шаги job и хвост лога.

## Темы (v3.50)

- Единые цветовые переменные светлой и тёмной тем — `assets/css/common.css`; цвета подсветки кода — токены `--tk-*`.
- При переключении темы нативные панели (шапка, нижнее и боковое меню, статус-бар) перекрашиваются в `MainActivity.repaintChrome()`.

## Иконка (v3.51)

- Адаптивная иконка (Android 8+): фон `drawable/ic_launcher_background.xml` + передний слой `mipmap-*/ic_launcher_foreground.png`; рисунок целиком лежит внутри безопасной зоны 66dp из 108dp, поэтому не обрезается маской лаунчера (круг, «squircle», квадрат).
- Монохромный слой `ic_launcher_monochrome.png` — для тематических иконок Android 13+.
- Для Android 7.x: `ic_launcher.png` и `ic_launcher_round.png` во всех плотностях (mdpi–xxxhdpi).
