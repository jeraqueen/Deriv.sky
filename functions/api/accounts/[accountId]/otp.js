export async function onRequestPost({ request, params }) {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ")) return Response.json({ok:false,error:"Connect Deriv first."},{status:401});
  const id = params.accountId;
  const response = await fetch("https://api.derivws.com/trading/v1/options/accounts/" + encodeURIComponent(id) + "/otp", {
    method:"POST", headers:{authorization:auth,"content-type":"application/json"}
  });
  return new Response(await response.text(), {status:response.status,headers:{"content-type":"application/json","cache-control":"no-store"}});
}