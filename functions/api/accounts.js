export async function onRequestGet({ request }) {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return Response.json({ok:false,error:"Connect Deriv first."},{status:401});
  const response = await fetch("https://api.derivws.com/trading/v1/options/accounts", {headers:{authorization:auth}});
  return new Response(await response.text(), {status:response.status,headers:{"content-type":"application/json","cache-control":"no-store"}});
}