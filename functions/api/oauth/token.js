export async function onRequestPost({ request }) {
  try {
    const { code, code_verifier, redirect_uri } = await request.json();
    if (!code || !code_verifier || !redirect_uri) return Response.json({ ok:false, error:"Missing OAuth fields." }, {status:400});
    const url = new URL(request.url);
    const expected = new URL("/callback", url.origin).href;
    if (redirect_uri !== expected) return Response.json({ok:false,error:"Redirect URL mismatch."},{status:400});
    const body = new URLSearchParams({
      grant_type:"authorization_code",
      client_id:"34QViCWtYpl4qov16nZy0",
      code, code_verifier, redirect_uri
    });
    const response = await fetch("https://auth.deriv.com/oauth2/token", {
      method:"POST",
      headers:{"content-type":"application/x-www-form-urlencoded"},
      body
    });
    const data = await response.json();
    if (!response.ok) return Response.json({ok:false,error:data.error_description || data.error || "Deriv token exchange failed."},{status:response.status});
    return Response.json({ok:true,access_token:data.access_token,expires_in:data.expires_in},{headers:{"cache-control":"no-store"}});
  } catch {
    return Response.json({ok:false,error:"OAuth exchange failed."},{status:500});
  }
}