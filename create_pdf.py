import os
import re
import base64
import zlib
import requests
import logging
import subprocess
import markdown
from pygments.formatters import HtmlFormatter

# Setup base per i log nel terminale
logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')

MD_FILE = "relazione.md"
HTML_FILE = "temp_relazione.html"
PDF_FILE = "relazione.pdf"

def fix_mermaid_syntax(mermaid_code: str) -> str:
    """Fixa gli errori del parser Mermaid aggiungendo le virgolette necessarie"""
    code = re.sub(r'([a-zA-Z0-9_]+)\s*\[([^\]"]+)\]', r'\1["\2"]', mermaid_code)
    counter = [0]
    def replacer(match):
        counter[0] += 1
        return f'subgraph sg_{counter[0]} ["{match.group(1)}"]'
    code = re.sub(r'subgraph\s+"([^"]+)"', replacer, code)
    return code

def get_kroki_url(mermaid_code: str) -> str:
    """Comprime e codifica il codice del diagramma per l'API di Kroki"""
    data = mermaid_code.encode('utf-8')
    compressed = zlib.compress(data, 9)
    encoded = base64.urlsafe_b64encode(compressed).decode('ascii')
    return f"https://kroki.io/mermaid/png/{encoded}"

def process_mermaid_blocks(md_content: str) -> str:
    """Trova i blocchi Mermaid, li invia a Kroki e li sostituisce con immagini Base64 inline"""
    pattern = re.compile(r"```mermaid\n(.*?)\n```", re.DOTALL)
    def replacer(match):
        original_code = match.group(1).strip()
        fixed_code = fix_mermaid_syntax(original_code)
        logging.info("Rendering Mermaid diagram via Kroki...")
        try:
            url = get_kroki_url(fixed_code)
            response = requests.get(url, timeout=20)
            if response.ok:
                b64 = base64.b64encode(response.content).decode('utf-8')
                return f"![Diagramma Architettura](data:image/png;base64,{b64})"
            return match.group(0)
        except Exception:
            return match.group(0)
    return pattern.sub(replacer, md_content)

def find_browser():
    """Cerca Chrome, Edge o Brave nel sistema (percorso Windows standard)"""
    paths = [
        r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
        r"C:\Program Files\Google\Chrome\Application\chrome.exe",
        r"C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
    ]
    for p in paths:
        if os.path.exists(p):
            return p
    return None

def create_pdf_report():
    if not os.path.exists(MD_FILE):
        logging.error(f"Errore: {MD_FILE} non trovato!")
        return

    try:
        logging.info("Lettura del markdown...")
        with open(MD_FILE, "r", encoding="utf-8") as f:
            md_content = f.read()

        # 1. Converte i diagrammi in immagini incorporate
        md_content = process_mermaid_blocks(md_content)

        # 2. Converte Markdown in HTML
        logging.info("Costruzione HTML strutturato e Highlighting del codice...")
        html_body = markdown.markdown(
            md_content, 
            extensions=['fenced_code', 'codehilite', 'tables']
        )

        # 3. Estrae il CSS per il tema scuro (Monokai)
        css_code = HtmlFormatter(style="monokai").get_style_defs('.codehilite')

        # 4. Compone un HTML bellissimo con regole SMART DI IMPAGINAZIONE
        html_doc = f"""
        <!DOCTYPE html>
        <html>
        <head>
            <meta charset="utf-8">
            <style>
                @page {{ margin: 20mm; }}
                body {{
                    font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
                    line-height: 1.6;
                    color: #222;
                }}
                
                /* --- REGOLE SMART PER I PAGE BREAKS (Evita orfane, vedove e titoli isolati) --- */
                
                h1, h2, h3, h4, h5, h6 {{ 
                    color: #111; 
                    margin-top: 1.5em; 
                    page-break-after: avoid; /* MAI spezzare la pagina dopo un titolo */
                    break-after: avoid;
                }}
                
                p, ul, ol, blockquote {{
                    orphans: 3; /* Minimo 3 righe in fondo alla pagina */
                    widows: 3;  /* Minimo 3 righe all'inizio della nuova pagina */
                }}
                
                li {{
                    page-break-inside: avoid; /* Cerca di non spezzare a metà un punto elenco */
                    break-inside: avoid;
                }}
                
                img {{ 
                    max-width: 100%; 
                    height: auto; 
                    display: block; 
                    margin: 1.5em auto; 
                    page-break-inside: avoid;
                }}
                
                /* --- FINE REGOLE PAGE BREAKS --- */

                h1 {{ font-size: 2.2em; border-bottom: 2px solid #eee; padding-bottom: 0.3em; }}
                h2 {{ font-size: 1.8em; border-bottom: 1px solid #eee; padding-bottom: 0.3em; }}
                
                /* Inietta i colori del codice scuro calcolati da Pygments */
                {css_code}
                
                /* Forza il riquadro nero perfetto (come VS Code) SENZA SCROLLBAR */
                .codehilite {{
                    background-color: #272822 !important; 
                    padding: 16px;
                    border-radius: 8px;
                    overflow: hidden; 
                    font-size: 14px;
                    box-shadow: 0 4px 6px rgba(0,0,0,0.1);
                    margin: 1.5em 0;
                    page-break-inside: avoid; /* Evita che il blocco di codice si spezzi a metà */
                    break-inside: avoid;
                }}
                .codehilite pre {{ 
                    margin: 0; 
                    font-family: Consolas, Monaco, "Courier New", monospace; 
                    white-space: pre-wrap;     
                    word-wrap: break-word;     
                }}
                
                /* Nasconde brutalmente le scrollbar al motore di rendering */
                ::-webkit-scrollbar {{ display: none; }}
                
                /* Stile per il codice inline (parole normali con backtick) */
                code {{
                    background-color: #f0f0f0;
                    color: #d14;
                    padding: 2px 5px;
                    border-radius: 4px;
                    font-family: Consolas, Monaco, monospace;
                    font-size: 0.9em;
                }}
                /* Annulla lo stile inline se siamo dentro al riquadro gigante */
                .codehilite code {{ background-color: transparent; color: inherit; padding: 0; }}
            </style>
        </head>
        <body>
            {html_body}
        </body>
        </html>
        """

        # Salva l'HTML temporaneo
        with open(HTML_FILE, "w", encoding="utf-8") as f:
            f.write(html_doc)

        # 5. Chiama Edge/Chrome per stampare
        browser_path = find_browser()
        if not browser_path:
            logging.error("Nessun browser trovato per stampare il PDF.")
            return

        logging.info(f"Stampa perfetta in corso tramite {os.path.basename(browser_path)}...")
        
        cmd = [
            browser_path,
            "--headless",
            "--disable-gpu",
            "--no-pdf-header-footer",
            f"--print-to-pdf={os.path.abspath(PDF_FILE)}",
            f"file:///{os.path.abspath(HTML_FILE)}"
        ]
        
        # Esegue il comando nascosto
        subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        
        # Pulisce il file HTML temporaneo
        if os.path.exists(HTML_FILE):
            os.remove(HTML_FILE)
            
        logging.info(f"FATTO! Creato {PDF_FILE}. Impaginazione intelligente applicata.")

    except Exception as e:
        logging.error(f"Errore critico durante l'esecuzione: {e}")

if __name__ == "__main__":
    create_pdf_report()