# double_mistake_finder

Два отдельных Tampermonkey-скрипта для Payment Support. Каждый ставится по своей ссылке, работают независимо
и могут стоять одновременно.

| Скрипт | Что делает | Установка | Кнопка / клавиши |
|---|---|---|---|
| **pay_mena Double Mistake Finder** | тикеты, где Approved (M) 2+ раза возвращали pay_mena_* | [pay_mena_double_mistake_finder.user.js](https://raw.githubusercontent.com/partenkoEgor/double_mistake_finder/main/pay_mena_double_mistake_finder.user.js) | **Double Mistakes** слева внизу, **Alt+D** |
| **pay_mena In Progress Finder** | тикеты в In progress: у кого и с каким комментарием | [pay_mena_in_progress_finder.user.js](https://raw.githubusercontent.com/partenkoEgor/double_mistake_finder/main/pay_mena_in_progress_finder.user.js) | **In Progress** слева внизу (над Double Mistakes), **Alt+I** |

## Установка и обновление
Открыть ссылку из таблицы в браузере с Tampermonkey и нажать **Установить**:

- Double Mistake Finder: **https://raw.githubusercontent.com/partenkoEgor/double_mistake_finder/main/pay_mena_double_mistake_finder.user.js**
- In Progress Finder: **https://raw.githubusercontent.com/partenkoEgor/double_mistake_finder/main/pay_mena_in_progress_finder.user.js**

Скрипты обновляются сами: Tampermonkey периодически проверяет ссылку и ставит новую версию, если в ней больше `@version`.
Проверить сразу: Tampermonkey → Панель управления → «Проверить обновления».

> До версии 2.0.0 режим In progress был внутри Double Mistake Finder. Теперь это отдельный скрипт — его нужно
> установить по своей ссылке один раз.

> Для разработчиков: при каждом изменении скрипта поднимайте `@version` (и `VERSION`), иначе обновление не придёт.

Работают на `th-managment.com` и `webmanegment.com`.

## Общее для обоих скриптов
- **Вариант 1 — по фильтру.** Выставить фильтр и нажать **APPLY**, затем кнопку сбора в панели. Скрипт пройдёт все
  страницы и загрузит историю каждого тикета (`/admin/backoffice/paymentsupporthistory`). Поддерживаются оба вида списка:
  - расширенный фильтр (`numberPage`/`countOfItemPage`, в ответе `{total}`) — останавливается по `total`
    (берётся с первой страницы: на следующих сервер присылает `total: 0`);
  - Payment Support (`page`/`perPage`, в ответе `otherData.hasMore`).
- **Вариант 2 — свои ID.** Вставить ID тикетов в поле (разделитель любой) и нажать кнопку проверки списка.
- **Потоков (1–5)** — сколько историй грузится параллельно (по умолчанию 3). Если сервер начинает отвечать 429/5xx,
  скрипт сам повторяет запросы с паузой; при частых ошибках уменьшите число потоков. В статусе показывается
  примерное оставшееся время.
- Если страница списка не пришла (сервер ещё готовит её — `is_polling`, ответ 5xx, сбой сети), скрипт повторяет её
  до 8 раз с паузой, а не заканчивает сбор. В «Сводке» видно: total по фильтру, сколько страниц пройдено и завершён ли
  сбор полностью или раньше времени (с причиной).
- **⏹ Стоп** останавливает сбор и выгружает то, что уже собрано.
- **Масштаб окна** — кнопки **−** / **+** в заголовке панели (80–200%, клик по проценту — сброс на 100%). Запоминается
  отдельно для каждого скрипта. При масштабе страницы 67% удобно ставить ~150%.

## Double Mistake Finder
Ищет тикеты, которые **2 и более раз** прошли такой цикл:

1. агент ставит **Approved (M)** (`nameExternalStatus`);
2. оператор `pay_mena_<число>` возвращает тикет в **Sent for processing (M)** с Inside Comment
   «Sir, please attach the approved transaction related to the payment from the ticket or set the right status.»

Проверяется вся история тикета, с любыми `pay_mena_*`. Кнопки: **▶ Сбор по APPLY**, **▶ Проверить список**.

### Что считается циклом
- Approved (M) → … → `pay_mena_*` ставит Sent for processing (M) с комментарием, в котором есть
  «please attach the approved transaction» (регистр, `// Sir,`, номер транзакции и `.x2` не важны).
- Возврат без предшествующего Approved не считается. Два возврата подряд на один Approved считаются как 1 цикл.
- Возвраты от других логинов (например, `pay_cm_mena_*`) или с другим текстом не считаются.

### Excel `double_mistakes_<дата>.xlsx`
- **Двойные ошибки** — один тикет на строку: Ticket type, GEO, число возвратов, кто и когда ставил Approved, кто и когда возвращал,
  текущий статус. Тикеты с 3+ возвратами подсвечены красным.
- **Детализация** — одна строка на каждый цикл, с Inside Comment на Approved и на возврате.
- **Сводка** — сколько тикетов проверено, найдено и пропущено, плюс возвраты по каждому `pay_mena_*`.

## In Progress Finder
Собирает список тикетов в работе:

1. В фильтре выбрать статусы In progress (у каждого из 4 типов тикета свой: «In progress» или «In progress (M)»), нажать **APPLY**.
2. Нажать **▶ In progress по APPLY** (или вставить ID и нажать **▶ In progress по списку**).

По каждому тикету в Excel `in_progress_<дата>.xlsx` — колонки:

| Колонка | Откуда |
|---|---|
| Ticket ID, Ticket type, GEO, User ID, Subagent, Referral, Agent, Department | строка списка (`idTicket`, `requestTypeName`, `nameCountry`, `idUser`, `nameSubagent`, `nameRef`, `nameAgent`, `department`) |
| Admin username, Inside comment, Последнее изменение | **самая свежая** строка истории тикета (`adminProcessedLogin`, `commentSupport`, `dateEdit`) |
| Дата создания | строка списка (`dtCreate`); для списка ID — самая ранняя строка истории |
| External status | строка списка; для списка ID — последняя строка истории |

Тикеты разложены по листам (листы есть всегда, даже пустые):

1. **Waiting for** — в Inside comment есть «waiting for» (регистр не важен), кто бы ни был Admin username;
2. **pay_mena** — Admin username `pay_mena_<номер>`;
3. **pay_mena_antifraud** — `pay_mena_antifraud_<номер>`;
4. **pay_support_mena** — `pay_support_mena_<номер>`;
5. **pay_cm_mena** — `pay_cm_mena_<номер>`;
6. **Остальные** — все прочие логины и пустой Admin username.

- Тикеты, которые по списку уже не в In progress, пропускаются без загрузки истории.
- Для списка ID поля тикета берутся из истории; Referral в истории нет, поэтому эта колонка будет пустой; то же с GEO (`nameCountry`).
- Лист **Сводка**: весь ли список пройден, сколько тикетов в In progress и сколько уже вышли из него, сколько тикетов на каждом листе, разбивка по Admin username и по Department.

## Тесты
```bash
node test/findDoubleMistakes.test.js
```
```bash
node test/inProgress.test.js
```
Логика каждого скрипта (`Detector` в начале файла) — чистые функции без DOM. Тесты прогоняют её на реальной (урезанной)
истории тикета 22961178 (`test/fixtures/`) и на синтетических граничных случаях.
