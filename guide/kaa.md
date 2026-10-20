# Yandex Disktan hámmesin qalay júklep alıw kerek

Ápiwayı kórsetpe. Shama menen bes minut waqıt aladı.

*Rus tilinen awdarılǵan — dúzetiwlerdi [GitHub](https://github.com/verhogladov/yandex-disk-download-all/issues) arqalı jiberseńiz, quwanamız.*

**Ne boldı.** 2026-jıl 11-oktyabrden baslap Yandex Disk saytında papkanı, bir neshe fayldı yamasa pútkil Disktı birden júklep alıw múmkin emes — tek birden-birden. «Yandex Disktan hámmesin júklep alıw» degen biypul brauzer keńeytpesi «Júklep alıw» túymesin qaytaradı: ol fayllardı birden-birden ózi júklep, Disktegidey papkalarǵa jaylastıradı.

**Ne kerek:**

- kompyuter yamasa noutbuk (Windows, macOS yamasa Linux);
- Google Chrome yamasa Yandex Brauzer (Edge, Opera, Brave, Vivaldi de jaraydı);
- kompyuterde bos orın — shama menen Diskte qansha orın iyelengen bolsa, sonsha.

Telefonda islemeydi: mobil brauzerlerge bunday keńeytpeni ornatıp bolmaydı. Kompyuter kerek.

## 1-qádem. Keńeytpeni júklep alıń

1. Basıń: **[yandex-disk-download-all.zip júklep alıw](https://github.com/verhogladov/yandex-disk-download-all/releases/latest/download/yandex-disk-download-all.zip)**. Fayl «Загрузки» papkasına saqlanadı.
2. Onı arxivten shıǵarıń:
   - **Windows:** faylǵa tıshqanshanıń oń túymesi menen basıń → «Извлечь все…» (hámmesin shıǵarıw) → «Извлечь»;
   - **macOS:** faylǵa eki ret basıń.
3. `yandex-disk-download-all` papkası payda boladı. Onı kesent bermeytuǵın jerge, mısalı «Документы» papkasına ótkeriń. Keyin óshirmeń: brauzer keńeytpeni usı papkadan aladı.

## 2-qádem. Keńeytpeni brauzerge ornatıń

**Google Chrome**

1. Mánzil qatarına `chrome://extensions` dep jazıń hám Enter basıń.
2. Joqarǵı oń múyeshte **«Режим разработчика»** (islep shıǵarıwshı rejimi, inglisshe Developer mode) almastırǵıshın qosıń.
3. Joqarǵı shep múyeshtegi birinshi túymeni basıń — **«Загрузить распакованное расширение»** (ashılǵan keńeytpeni júklew, inglisshe Load unpacked).
4. `yandex-disk-download-all` papkasın saylań (ishinde `manifest.json` faylı bar papka).
5. Dizimde keńeytpe payda boladı. Tayar.

**Yandex Brauzer** — tap usınday, tek mánzili `browser://extensions`.

**Edge, Opera, Brave, Vivaldi** — mánzilleri `edge://extensions`, `opera://extensions`, `brave://extensions`, `vivaldi://extensions`, ári qaray tap usınday: «Режим разработчика» → «Загрузить распакованное».

> «Режим разработчика» — bul ádettegi jaǵday: dúkannan emes keńeytpeler usılay ornatıladı. Keńeytpe biypul, kodı ashıq. Eger brauzer iske túskende bunday keńeytpelerdi óshiriwdi usınıs etse — bas tartıń.

## 3-qádem. «Qayda saqlaw» sorawın óshiriń

Áytpese brauzer hár bir fayl haqqında soraydı, al olar mıńlaǵan bolıwı múmkin.

- **Chrome:** `chrome://settings/downloads` ashıń hám **«Всегда указывать место для скачивания»** (hár bir fayldı qayda saqlawdı soraw) degendi óshiriń.
- **Yandex Brauzer:** «Настройки» → «Инструменты» → «Загруженные файлы» → **«Всегда спрашивать, куда сохранять файлы»** belgisin alıp taslań.
- **Basqa brauzerler:** sazlamalardıń júklewler bóliminde hár bir fayldı qayda saqlaw haqqındaǵı sorawdı óshiriń.

## 4-qádem. Fayllardı júklep alıń

1. [disk.yandex.ru](https://disk.yandex.ru) ashıń hám akkauntıńızǵa kiriń. Disk aldınnan ashıq bolsa — betti jańalań (F5).
2. Tómengi oń múyeshte kók **«Pútkil Disktı júklep alıw»** túymesi payda boladı. Papka ishinde ol «Papkanı júklep alıw» dep ataladı, al fayllardı belgileseńiz — «Belgilengendi júklep alıw».
3. Onı basıń. Ayna ashıladı:
   - **«Neni júklep alıw»** — pútkil Disk, usı papka, belgilengenler yamasa dizimnen «Fayllar hám papkalardı saylaw…»;
   - **«Qanday fayllar»** — hámmesi yamasa «Tek kerekli túrler» (mısalı, tek foto hám video);
   - **«Qayda saqlaw»** — kompyuterge Disktegidey fayllar túrinde, bir ZIP-arxiv túrinde yamasa basqa bultqa.
4. **«Júklewdi baslaw»** túymesin basıp, kútiń. Aynada qanshası júklengeni kórinedi.

![Keńeytpe aynası](../docs/setup.png)

*Súwrette — rus tilindegi interfeys. Til aynanıń joqarǵı qatarında saylanadı: 23 til bar, qaraqalpaqsha da bar.*

**Júklew dawam etip atırǵanda** Disk betin kishireytiwge boladı, biraq onı **jappań**. Bet jabılıp qalsa yamasa kompyuter óship qalsa — Disktı qayta ashıń hám «Dawam etiw» túymesin basıń. Júklenip bolǵan fayllar qayta júklenbeydi.

**Fayllar qayda:** «Загрузки» → «Yandex Disk», Disktegidey papkalar boyınsha.

## Bir nárse shıqpasa

| Ne kórinedi | Ne islew kerek |
| --- | --- |
| Kók túyme joq | Disk betin jańalań (F5). `chrome://extensions` ishinde keńeytpe qosılǵanın tekseriń. |
| Brauzer hár bir fayldı qayda saqlawdı soraydı | 3-qádemdi orınlań hám «Dawam etiw» basıń. |
| Ayırım fayllar «Ámelge aspadı» | Yandex serverleri házir hámmesin bermeydi. Bir-eki saattan keyin «Ámelge aspaǵanların qaytalaw» basıń. Bunday fayllardıń dizimin «Esabat (CSV)» túymesi saqlaydı. |
| Kompyuterde orın az | Bóleklerge bólingen «ZIP-arxiv», bultqa kóshiriw yamasa brauzer sazlamalarında sırtqı disktı júklewler papkası etip saylań. |
| «Yandex tekseriwden ótiwdi soraydı» | «Tekseriwden ótiw» basıń, robot emes ekenińizdi tastıyıqlań, keyin «Dawam etiw» basıń. |
| Foto atında «(aldın ala kórinis)» bar | Túp nusqa berilmedi, kishireytilgen kóshirmesi saqlandı. Keyinirek «Aldın ala kórinistiń ornına túp nusqalardı qayta sınap kóriw» basıń. |

## Bul qáwipsiz be?

- Keńeytpe tek Yandex Disk saytında hám tek sizdiń brauzerińizde isleydi. Yandex parolin soramaydı. Fayllarıńız hesh jerge jiberilmeydi — ózińiz jalǵaǵan bulttan basqa.
- Bul Yandex baǵdarlaması emes, kodı ashıq ǵárezsiz biypul joybar.

## Qalay óshiriw yamasa jańalaw kerek

- **Óshiriw:** `chrome://extensions` → keńeytpe janındaǵı «Удалить». Júklengen fayllar qaladı.
- **Jańalaw:** arxivti qayta júklep alıń (1-qádem), eski papkanıń ústine fayllardı almastırıp shıǵarıń, keyin `chrome://extensions` ishinde keńeytpe janındaǵı dóńgelek strelkanı basıń.

## Járdem kerek pe?

[Joybardıń sorawlar betine](https://github.com/verhogladov/yandex-disk-download-all/issues) jazıń (biypul GitHub akkauntı kerek). Ne islegenińizdi hám ne kórgenińizdi aytıń; skrinshot kóp járdem beredi.
