import {createRoot} from "react-dom/client";
import {useRoute} from "../src/routing";
function App(){const {route,navigate}=useRoute();return <><pre id="route">{JSON.stringify(route)}</pre><button onClick={()=>navigate({kind:"allAgents"})}>Agents workspace</button><button onClick={()=>navigate({kind:"create",resource:"chat",surface:"workspace"})}>Logo</button></>;}
createRoot(document.getElementById("root")!).render(<App/>);
