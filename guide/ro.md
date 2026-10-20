# Cum să descărcați totul de pe Yandex Disk

Instrucțiuni simple. Durează cam cinci minute.

*Tradus din rusă — corecturile sunt binevenite pe [GitHub](https://github.com/verhogladov/yandex-disk-download-all/issues).*

**Ce s-a întâmplat.** Din 11 octombrie 2026, pe site-ul Yandex Disk nu se mai poate descărca un dosar, mai multe fișiere sau tot Discul deodată — doar câte un fișier. Extensia gratuită de browser „Descarcă tot din Yandex Disk” readuce butonul „Descarcă”: descarcă singură fișierele unul câte unul și le pune în aceleași dosare ca pe Disc.

**De ce aveți nevoie:**

- un calculator sau laptop (Windows, macOS sau Linux);
- Google Chrome sau Yandex Browser (merg și Edge, Opera, Brave, Vivaldi);
- spațiu liber pe calculator — aproximativ cât ocupă Discul.

Pe telefon nu funcționează: în browserele mobile nu se poate instala o astfel de extensie. Aveți nevoie de un calculator.

## Pasul 1. Descărcați extensia

1. Apăsați: **[descarcă yandex-disk-download-all.zip](https://github.com/verhogladov/yandex-disk-download-all/releases/latest/download/yandex-disk-download-all.zip)**. Fișierul se salvează în dosarul „Descărcări”.
2. Dezarhivați-l:
   - **Windows:** clic dreapta pe fișier → „Extragere totală…” → „Extragere”;
   - **macOS:** dublu clic pe fișier.
3. Apare dosarul `yandex-disk-download-all`. Mutați-l acolo unde nu încurcă, de exemplu în „Documente”. Nu-l ștergeți după aceea: browserul ia extensia din acest dosar.

## Pasul 2. Instalați extensia în browser

**Google Chrome**

1. Lipiți în bara de adrese `chrome://extensions` și apăsați Enter.
2. În colțul din dreapta sus, activați comutatorul **„Modul pentru dezvoltatori”** (engleză: Developer mode).
3. În colțul din stânga sus, apăsați primul buton — **„Încarcă extensia neîmpachetată”** (engleză: Load unpacked).
4. Alegeți dosarul `yandex-disk-download-all` (cel în care se află fișierul `manifest.json`).
5. În listă apare „Descarcă tot din Yandex Disk”. Gata.

**Yandex Browser** — la fel, doar că adresa este `browser://extensions`.

**Edge, Opera, Brave, Vivaldi** — adresele `edge://extensions`, `opera://extensions`, `brave://extensions`, `vivaldi://extensions`, apoi la fel: „Modul pentru dezvoltatori” → „Încarcă extensia neîmpachetată”.

> „Modul pentru dezvoltatori” e normal: așa se instalează extensiile care nu sunt din magazin. Extensia este gratuită, iar codul ei e deschis. Dacă browserul vă propune la pornire să dezactivați astfel de extensii — refuzați.

## Pasul 3. Dezactivați întrebarea „unde să salvez”

Altfel browserul va întreba despre fiecare fișier, iar ele pot fi mii.

- **Chrome:** deschideți `chrome://settings/downloads` și dezactivați **„Întreabă unde se salvează fiecare fișier înainte de descărcare”** (engleză: Ask where to save each file before downloading).
- **Yandex Browser:** Setări → Instrumente → Fișiere descărcate → debifați **„Întreabă întotdeauna unde să salvezi fișierele”** (în rusă «Всегда спрашивать, куда сохранять файлы»).
- **Alte browsere:** în setări, la secțiunea de descărcări, dezactivați întrebarea despre locul de salvare a fiecărui fișier.

## Pasul 4. Descărcați fișierele

1. Deschideți [disk.yandex.ru](https://disk.yandex.ru) și conectați-vă la cont. Dacă Discul era deja deschis — reîncărcați pagina (F5).
2. În colțul din dreapta jos apare butonul albastru **„Descarcă tot Discul”**. Într-un dosar se numește „Descarcă dosarul”, iar dacă selectați fișiere — „Descarcă selecția”.
3. Apăsați-l. Se deschide o fereastră:
   - **„Ce să descărcăm”** — tot Discul, acest dosar, selecția sau „Alegeți fișiere și dosare…” din listă;
   - **„Ce fișiere”** — toate sau „Doar tipurile necesare” (de exemplu, doar fotografii și video);
   - **„Unde să salvăm”** — pe calculator ca fișiere, ca pe Disc, ca o singură arhivă ZIP sau în alt cloud.
4. Apăsați **„Începe descărcarea”** și așteptați. În fereastră se vede cât s-a descărcat deja.

![Fereastra extensiei](../docs/setup.png)

*În imagine este interfața în rusă. Limba se alege în rândul de sus al ferestrei: sunt 23 de limbi, inclusiv româna.*

**Cât timp durează descărcarea**, fila cu Discul poate fi minimizată, dar **nu o închideți**. Dacă fila s-a închis sau calculatorul s-a oprit — deschideți Discul din nou și apăsați „Continuă”. Ce s-a descărcat deja nu se mai descarcă a doua oară.

**Unde sunt fișierele:** „Descărcări” → „Yandex Disk”, în aceleași dosare ca pe Disc.

## Dacă ceva nu a mers

| Ce vedeți | Ce faceți |
| --- | --- |
| Nu există butonul albastru | Reîncărcați pagina Discului (F5). Verificați în `chrome://extensions` că extensia este activată. |
| Browserul întreabă unde să salveze fiecare fișier | Faceți pasul 3 și apăsați „Continuă”. |
| Unele fișiere sunt „Eșuate” | Serverele Yandex nu oferă acum totul. Peste o oră-două apăsați „Reîncearcă eșuatele”. Lista acestor fișiere o salvează butonul „Raport (CSV)”. |
| Spațiu puțin pe calculator | Alegeți „Arhivă ZIP” pe părți, transferul în cloud sau un disc extern ca dosar de descărcări în setările browserului. |
| „Yandex cere verificarea «Nu sunt robot»” | Apăsați „Treceți verificarea”, dovediți că nu sunteți robot, apoi apăsați „Continuă”. |
| În numele fotografiei apare „(previzualizare)” | Originalul nu a fost oferit, s-a salvat o copie micșorată. Mai târziu apăsați „Încearcă din nou originalele în loc de previzualizări”. |

## Este sigur?

- Extensia funcționează doar pe site-ul Yandex Disk și doar în browserul dumneavoastră. Nu cere parola Yandex. Fișierele nu pleacă nicăieri, în afară de cloudul pe care îl conectați singuri.
- Nu este un program Yandex, ci un proiect independent, gratuit, cu cod deschis.

## Cum o eliminați sau o actualizați

- **Eliminare:** `chrome://extensions` → „Elimină” la extensie. Fișierele descărcate rămân.
- **Actualizare:** descărcați din nou arhiva (pasul 1), dezarhivați-o peste dosarul vechi înlocuind fișierele, apoi în `chrome://extensions` apăsați săgeata rotundă de la extensie.

## Aveți nevoie de ajutor?

Scrieți pe [pagina de întrebări a proiectului](https://github.com/verhogladov/yandex-disk-download-all/issues) (e nevoie de un cont GitHub gratuit). Spuneți ce ați făcut și ce ați văzut; o captură de ecran ajută mult.
