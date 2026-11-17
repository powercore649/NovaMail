/* ------------------------------------------------------------------ */
/* NovaMail — réception Cloudflare                                     */
/*                                                                     */
/* À déployer dans Cloudflare (Workers & Pages → le Worker), puis :    */
/* Email Routing → Routing rules → Catch-all address → Edit →          */
/* Action « Send to a Worker » → choisir ce Worker.                    */
/*                                                                     */
/* Variable à créer sur le Worker : NOVAMAIL_INBOUND_SECRET            */
/* (même valeur que dans Freebuff → Sites → NovaMail → Secrets).       */
/* ------------------------------------------------------------------ */

export default {
  async email(message, env) {
    const raw = await new Response(message.raw).text();

    const response = await fetch('https://novamail.freebuff.page/api/inbound-raw', {
      method: 'POST',
      headers: {
        'content-type': 'message/rfc822',
        'x-novamail-secret': env.NOVAMAIL_INBOUND_SECRET || '',
      },
      body: raw,
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.log('NovaMail a refusé le message', response.status, detail.slice(0, 200));
    }
  },
};
